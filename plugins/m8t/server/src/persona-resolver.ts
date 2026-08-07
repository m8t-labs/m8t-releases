import type { PersonaFrontmatter } from "./persona-file.js";

interface RenderArgs {
  persona: string | null;
  frontmatter: PersonaFrontmatter | null;
}

export function renderRoleHint(args: RenderArgs): string | null {
  if (!args.persona) return null;

  if (args.frontmatter?.role) {
    return args.frontmatter.role;
  }

  if (args.frontmatter && !args.frontmatter.role) {
    return titleCaseSlug(args.persona);
  }

  return `${args.persona} (persona file not found)`;
}

function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function shortenDescription(desc: string): string {
  if (!desc) return "";
  const firstSentenceMatch = /^([^.!?]+)([.!?]|$)/.exec(desc);
  let result = firstSentenceMatch ? firstSentenceMatch[1].trim() : desc.trim();
  if (result.length > 80) {
    result = result.slice(0, 80) + "...";
  }
  return result;
}
