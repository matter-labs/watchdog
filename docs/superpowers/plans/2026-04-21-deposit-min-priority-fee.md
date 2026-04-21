# Deposit Minimum Priority Fee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply a configurable minimum L1 deposit priority fee in watchdog-only deposit transactions and document the option.

**Architecture:** Keep the change local to watchdog by resolving a minimum `maxPriorityFeePerGas` before constructing deposit params. Use a small helper so the behavior is directly unit-testable without patching `@matterlabs/zksync-js`.

**Tech Stack:** TypeScript, Node built-in test runner, ts-node, yarn

---

### Task 1: Add Test Coverage For Priority Fee Resolution

**Files:**
- Create: `tests/depositPriorityFee.test.ts`
- Modify: `package.json`
- Test: `tests/depositPriorityFee.test.ts`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run `yarn test tests/depositPriorityFee.test.ts` to verify it fails**
- [ ] **Step 3: Add the minimal test script needed to run the test file**
- [ ] **Step 4: Run the same test command and confirm the behavior still fails for the missing helper**

### Task 2: Implement The Watchdog Helper And Wire It Into Deposits

**Files:**
- Create: `src/depositPriorityFee.ts`
- Modify: `src/deposit.ts`
- Test: `tests/depositPriorityFee.test.ts`

- [ ] **Step 1: Implement the helper that returns the larger of provider tip and configured minimum**
- [ ] **Step 2: Use the helper when building `l1TxOverrides` for deposit quote/create**
- [ ] **Step 3: Run `yarn test tests/depositPriorityFee.test.ts` and confirm it passes**

### Task 3: Document And Verify

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document `FLOW_DEPOSIT_MIN_PRIORITY_FEE_GWEI` with default `0.001 gwei`**
- [ ] **Step 2: Run `yarn lint:check`, `yarn typecheck`, and `yarn test tests/depositPriorityFee.test.ts`**
- [ ] **Step 3: Commit the change set**
- [ ] **Step 4: Push the branch and open a draft PR**
