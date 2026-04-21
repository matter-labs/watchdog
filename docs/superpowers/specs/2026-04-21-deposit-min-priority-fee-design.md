# Deposit Minimum Priority Fee Design

## Goal

Ensure watchdog deposits never use an L1 `maxPriorityFeePerGas` lower than a configurable
minimum, while keeping all other fee selection behavior unchanged.

## Scope

- Apply only to watchdog deposit flow.
- Affect both `sdk.deposits.quote()` and `sdk.deposits.create()` by setting
  `l1TxOverrides.maxPriorityFeePerGas`.
- Default the minimum to `0.001 gwei`.
- Document the option in `README.md`.

## Approach

Add a small helper in watchdog code that:

- reads `FLOW_DEPOSIT_L1_MIN_PRIORITY_FEE_GWEI` from the environment
- converts the configured gwei value to wei
- asks the L1 provider for `getFeeData().maxPriorityFeePerGas`
- returns the larger of the provider value and the configured minimum

`DepositFlow` will use that resolved value when building deposit params for quote and create.
`maxFeePerGas` stays untouched, so the existing skip behavior based on
`FLOW_DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI` remains unchanged.

## Testing

Add a focused unit test for the helper covering:

- provider tip below the configured minimum
- provider tip above the configured minimum
- provider tip missing
- default configuration value
