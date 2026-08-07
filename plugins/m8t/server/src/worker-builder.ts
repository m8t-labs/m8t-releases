import type { AgentRecord } from "./foundry-client.js";
import { readPersonaFrontmatter } from "./persona-file.js";
import { renderRoleHint, shortenDescription } from "./persona-resolver.js";
import type { WorkerKind, HostedBlock } from "@m8t-stack/foundry-invoke";
import { parseBrainLink, type BrainLink } from "./brain-link.js";

export interface WorkerRecord {
  name: string;
  displayName: string;
  role: string | null;
  description: string;
  persona: string | null;
  personaVersion: string | null;
  agentId: string;
  projectEndpoint: string;
  model: string;
  deployedAt: string | null;
  kind: WorkerKind;
  hosted?: HostedBlock;
  brain?: BrainLink;
}

interface BuildOpts {
  repoRoot: string;
  projectEndpoint: string;
}

export async function buildWorkerRecord(agent: AgentRecord, opts: BuildOpts): Promise<WorkerRecord> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- metadata is Record<string,string> so `.persona` types as string, but the key is often absent at runtime (noUncheckedIndexedAccess is off); `?? null` normalizes the missing-key case to WorkerRecord's `string | null`.
  const persona = agent.metadata.persona ?? null;
  const frontmatter = persona
    ? await readPersonaFrontmatter({ repoRoot: opts.repoRoot, persona })
    : null;

  const role = renderRoleHint({ persona, frontmatter });
  const description = frontmatter ? shortenDescription(frontmatter.description) : "";

  return {
    name: agent.name.toLowerCase(),
    displayName: agent.name,
    role,
    description,
    persona,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same as `persona` above: the personaVersion key is often absent at runtime; `?? null` normalizes it.
    personaVersion: agent.metadata.personaVersion ?? null,
    agentId: agent.id,
    projectEndpoint: opts.projectEndpoint,
    model: agent.model,
    deployedAt: agent.createdAt ?? null,
    kind: agent.kind,
    hosted: agent.hosted,
    brain: parseBrainLink(agent.metadata),
  };
}
