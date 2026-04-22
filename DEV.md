# Watchdog Development Notes

## Project Structure

- `src/index.ts`: Process entrypoint. Configures logging, acquires the Kubernetes Lease, then starts
  the watchdog.
- `src/leaseLock.ts`: Minimal Lease-based singleton lock for Kubernetes using
  `coordination.k8s.io/v1`.
- `src/main.ts`: Starts the metrics server and enabled watchdog flows after leadership is acquired.
- `src/*.ts`: Flow implementations and shared helpers used by the watchdog runtime.
- `k8s/rbac.yaml`: Minimal ServiceAccount, Role, RoleBinding, and deployment example for Lease
  access.

## Architecture Notes

The app now gates startup on a Kubernetes Lease. Followers do not run flows before they acquire the
Lease. The active holder renews the Lease every 30 seconds with `metadata.resourceVersion`. Any
renew error or update conflict is treated as leadership loss and terminates the process with exit
code `1` so Kubernetes can restart it.
