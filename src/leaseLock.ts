import { ApiException, CoordinationV1Api, KubeConfig, V1MicroTime } from "@kubernetes/client-node";
import winston from "winston";

import { SEC, timeoutPromise, unwrap } from "./utils";

import type { V1Lease } from "@kubernetes/client-node";

const LEASE_DURATION_SECONDS = 45;
const ACQUIRE_RETRY_MS = 30 * SEC;
const RENEW_INTERVAL_MS = 30 * SEC;

type LeaseContext = {
  api: CoordinationV1Api;
  holderIdentity: string;
  leaseName: string;
  namespace: string;
};

/**
 * Blocks startup until this process acquires the Kubernetes Lease, then keeps renewing it.
 * The process exits with code 1 if renewal fails or leadership is lost.
 */
export async function acquireAndHoldLeaseOrExit(): Promise<void> {
  const context = getLeaseContext();
  const lease = await acquireLease(context);
  void renewLeaseLoop(context, lease);
}

function getLeaseContext(): LeaseContext {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromCluster();

  return {
    api: kubeConfig.makeApiClient(CoordinationV1Api),
    holderIdentity: unwrap(process.env.POD_NAME ?? process.env.HOSTNAME, "POD_NAME or HOSTNAME"),
    leaseName: process.env.LEASE_NAME ?? "app-singleton",
    namespace: process.env.POD_NAMESPACE ?? "default",
  };
}

function buildLease(context: LeaseContext, resourceVersion?: string, leaseTransitions = 0): V1Lease {
  return {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: {
      name: context.leaseName,
      namespace: context.namespace,
      resourceVersion,
    },
    spec: {
      holderIdentity: context.holderIdentity,
      leaseDurationSeconds: LEASE_DURATION_SECONDS,
      leaseTransitions,
      renewTime: new V1MicroTime(),
    },
  };
}

function isLeaseExpired(lease: V1Lease): boolean {
  const renewTime = lease.spec?.renewTime ? new Date(lease.spec.renewTime).getTime() : 0;
  const durationSeconds = lease.spec?.leaseDurationSeconds ?? 0;
  return renewTime + durationSeconds * SEC <= Date.now();
}

function nextLeaseTransitions(lease: V1Lease, holderIdentity: string): number {
  const currentTransitions = lease.spec?.leaseTransitions ?? 0;
  return lease.spec?.holderIdentity === holderIdentity ? currentTransitions : currentTransitions + 1;
}

function isConflictError(error: unknown): boolean {
  return error instanceof ApiException && error.code === 409;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiException && error.code === 404;
}

function exitOnLeaseLoss(message: string, error?: unknown): never {
  winston.error(message, error);
  process.exit(1);
}

async function readLease(context: LeaseContext): Promise<V1Lease | null> {
  try {
    return await context.api.readNamespacedLease({
      name: context.leaseName,
      namespace: context.namespace,
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function createLease(context: LeaseContext): Promise<V1Lease | null> {
  try {
    return await context.api.createNamespacedLease({
      namespace: context.namespace,
      body: buildLease(context),
    });
  } catch (error) {
    if (isConflictError(error)) {
      return null;
    }
    throw error;
  }
}

async function replaceLease(context: LeaseContext, lease: V1Lease): Promise<V1Lease> {
  const resourceVersion = lease.metadata?.resourceVersion;
  if (!resourceVersion) {
    throw new Error(`Lease ${context.namespace}/${context.leaseName} is missing metadata.resourceVersion`);
  }

  return await context.api.replaceNamespacedLease({
    name: context.leaseName,
    namespace: context.namespace,
    body: buildLease(context, resourceVersion, nextLeaseTransitions(lease, context.holderIdentity)),
  });
}

async function acquireLease(context: LeaseContext): Promise<V1Lease> {
  while (true) {
    try {
      const lease = await readLease(context);

      if (!lease) {
        const createdLease = await createLease(context);
        if (createdLease) {
          winston.info(`Acquired Lease ${context.namespace}/${context.leaseName} by creating it`);
          return createdLease;
        }
        continue;
      }

      if (lease.spec?.holderIdentity === context.holderIdentity) {
        const renewedLease = await replaceLease(context, lease);
        const leadershipMessage =
          `Continuing as leader for Lease ${context.namespace}/${context.leaseName} ` + `as ${context.holderIdentity}`;
        winston.info(leadershipMessage);
        return renewedLease;
      }

      if (isLeaseExpired(lease)) {
        try {
          const replacedLease = await replaceLease(context, lease);
          winston.info(`Acquired expired Lease ${context.namespace}/${context.leaseName} as ${context.holderIdentity}`);
          return replacedLease;
        } catch (error) {
          if (isConflictError(error)) {
            winston.warn(
              `Lease takeover conflicted for ${context.namespace}/${context.leaseName}; retrying in ` +
                `${ACQUIRE_RETRY_MS / SEC} seconds`
            );
            await timeoutPromise(ACQUIRE_RETRY_MS);
            continue;
          }
          throw error;
        }
      }

      winston.info(
        `Lease ${context.namespace}/${context.leaseName} is held by ` +
          `${lease.spec?.holderIdentity ?? "unknown"}; retrying in ${ACQUIRE_RETRY_MS / SEC} seconds`
      );
    } catch (error) {
      winston.error(
        `Failed to acquire Lease ${context.namespace}/${context.leaseName}; retrying in ` +
          `${ACQUIRE_RETRY_MS / SEC} seconds`,
        error
      );
    }

    await timeoutPromise(ACQUIRE_RETRY_MS);
  }
}

async function renewLeaseLoop(context: LeaseContext, lease: V1Lease): Promise<never> {
  let currentLease = lease;

  while (true) {
    await timeoutPromise(RENEW_INTERVAL_MS);

    if (currentLease.spec?.holderIdentity !== context.holderIdentity) {
      exitOnLeaseLoss(`Lease ${context.namespace}/${context.leaseName} is no longer held by ${context.holderIdentity}`);
    }

    try {
      currentLease = await replaceLease(context, currentLease);
      if (currentLease.spec?.holderIdentity !== context.holderIdentity) {
        exitOnLeaseLoss(
          `Lease ${context.namespace}/${context.leaseName} was renewed with holder ` +
            `${currentLease.spec?.holderIdentity ?? "unknown"}`
        );
      }
    } catch (error) {
      exitOnLeaseLoss(`Failed to renew Lease ${context.namespace}/${context.leaseName}`, error);
    }
  }
}
