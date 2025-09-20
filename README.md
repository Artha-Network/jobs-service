# jobs-service
Deadlines, reminders, auto-escalations; consumes Helius (or QuickNode) webhooks; optionally triggers resolve or notifications.

---

```md
# Jobs Service (Timers, Webhooks, Escalations)

Background workers for deadlines, reminders, and automatic escalations. Consumes **Helius** webhooks and triggers notifications or safe fallback actions.

## Responsibilities
- Schedule dispute windows & delivery deadlines
- Notify parties at key milestones
- On timeout: create **resolve** suggestion (conservative) or ping human reviewer
- Idempotent processing with retry backoff

## Structure
src/
worker.ts
queues/ # deadlines, reminders, escalation
processors/ # handleDeadline, handleReminder, handleEscalation
ports/ # ChainPort, ApiPort, NotifyPort
infra/ # helius.webhook, chain.client, notify.dialect

## Environment
| Var | Description |
|-----|-------------|
| `REDIS_URL` | BullMQ backing |
| `RPC_URL` | Solana RPC |
| `HELIUS_WEBHOOK_SECRET` | verify webhook authenticity |
| `ACTIONS_BASEURL` | to rebuild txs if needed |

## Run
```bash
pnpm i
pnpm start:worker
Test
pnpm test
# Fake timers validate exactly-once execution & idempotency
Observability

Structured JSON logs

Metrics: job latency, retries, dead-letter counts

License

MIT
