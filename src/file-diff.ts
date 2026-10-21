import { createTwoFilesPatch, diffLines } from "diff";

/** DevEco's existing Web and terminal cards consume these fields directly. */
export function fileDiff(file: string, before: string, after: string) {
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) additions += part.count ?? 0;
    if (part.removed) deletions += part.count ?? 0;
  }
  return { file, before, after, additions, deletions, patch: createTwoFilesPatch(file, file, before, after) };
}
