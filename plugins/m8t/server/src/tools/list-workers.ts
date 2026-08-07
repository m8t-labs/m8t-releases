import type { FoundryClient } from "../foundry-client.js";
import { isM8tStackAgent } from "../foundry-client.js";
import { buildWorkerRecord, type WorkerRecord } from "../worker-builder.js";

interface Args {
  client: FoundryClient;
  repoRoot: string;
  projectEndpoint: string;
}

export async function handleListWorkers(args: Args): Promise<WorkerRecord[]> {
  const agents = await args.client.listAgents();
  const m8tAgents = agents.filter(isM8tStackAgent);
  return Promise.all(
    m8tAgents.map((agent) =>
      buildWorkerRecord(agent, {
        repoRoot: args.repoRoot,
        projectEndpoint: args.projectEndpoint,
      }),
    ),
  );
}
