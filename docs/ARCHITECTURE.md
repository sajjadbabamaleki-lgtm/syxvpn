# Jordan VPN Architecture

## Components

### 1. Subscription service
Creates revocable per-user subscription identifiers and returns client profiles for currently healthy gateways.

### 2. Gateway registry
Stores gateway metadata, availability state, capacity and last health-check time.

### 3. Egress manager
Represents upstream connectivity independently from client-facing gateways. This allows routes to be enabled, disabled or reprioritized without changing every customer account.

### 4. Account service
Tracks account state, expiry, traffic quota and device policy.

### 5. Health monitor
Continuously evaluates registered gateways and removes unhealthy nodes from newly generated subscriptions.

### 6. Blackout lab
A controlled test environment in which ordinary client traffic is blocked while explicitly configured lab gateways remain reachable. This is used to test DNS behavior, reconnection and failover without relying on a real outage.

## Data model

- User
- Subscription
- Gateway
- EgressRoute
- UsageRecord
- HealthCheck

## Security principles

- No credentials committed to source control.
- Subscription tokens must be revocable and high entropy.
- Administrative API is separate from public subscription endpoints.
- Gateway secrets are supplied through deployment secrets/environment variables.
- Egress routes must be explicitly configured rather than discovered or acquired through unauthorized access.

## MVP sequence

1. Account and subscription API
2. Gateway registry and health checks
3. Profile renderer
4. Quota/expiry enforcement
5. Egress abstraction and failover
6. Blackout simulation tests
7. Administration interface
