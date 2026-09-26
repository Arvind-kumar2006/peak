# agent/ — P3 (Vaibhav Kumawat)

Agent brain: TrueForge setup, AgentSpec, instructions, verification logic, evals. See [contracts/trueforge.md](../contracts/trueforge.md).

## `lib/` — shared TrueForge client (P4's backend imports this too)

| File | What |
|---|---|
| `providers.mjs` | Model providers in fallback order: **OpenAI → Grok (xAI)**, plus `mock`. Configured via `MODEL_PROVIDERS`, `OPENAI_*`, `XAI_*` in `.env` |
| `trueforge-client.mjs` | `createClient({ providers })` → `registerProviders`, `registerMcpServer`, `createSession`, `start`, `approve`, `reject`, `sessionUrl`. A turn that fails with a model error switches the session to the next provider and retries |

```js
import { providersFromEnv } from '../agent/lib/providers.mjs';
import { createClient } from '../agent/lib/trueforge-client.mjs';

const tf = createClient({ providers: providersFromEnv() });
await tf.registerProviders();
const session = await tf.createSession(agentSpecWithoutModel, { incidentId });
const paused = await tf.start(session, 'Investigate: error rate spiking on /orders');
if (paused.kind === 'approval') {
  const done = await tf.approve(session, paused);   // or tf.reject(session, paused, 'reason')
  console.log(done.state.output.content);           // final report
}
```

## `spike/` — Phase 0 experiments

Approval gate and model fallback tests, plus the scripted mock model. See [spike/README.md](spike/README.md).
