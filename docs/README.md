# Documentation Index

This directory defines the initial product and engineering package for `openai-shared-proxy`.

Recommended reading order:

1. [requirements_prd.md](./requirements_prd.md)
   Product scope, constraints, and success criteria.
2. [implementation_plan.md](./implementation_plan.md)
   Proposed modules, routing behavior, and verification outline.
3. [architecture.md](./architecture.md)
   Runtime structure, request flow, and component boundaries.
4. [api_contract.md](./api_contract.md)
   Public HTTP surface and response expectations.
5. [config_reference.md](./config_reference.md)
   Environment variables, secrets, and deployment defaults.
6. [engineering_notes.md](./engineering_notes.md)
   Non-goals, coding guardrails, and implementation decisions.

This set is intended to be sufficient for a new engineer to:
- understand what v1 is and is not
- scaffold the service without guessing policy
- align implementation with operational and security expectations
