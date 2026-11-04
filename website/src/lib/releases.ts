export interface Download { platform: string; arch: string; variant: string; url: string; size_bytes: number }
export interface ReleaseEntry {
  version: string; date: string; published_at: string | null; summary: string;
  notes_url: string; notes_json_url: string; github_url: string;
  downloads: Download[]; base: string | null;
}
export interface ReleaseIndex { mode: 'preview' | 'published'; latest_stable: string | null; releases: ReleaseEntry[] }
export const releaseDate = (release: ReleaseEntry) => (release.published_at || release.date).slice(0, 10);
export const releaseId = (version: string) => `release-${version.replaceAll('.', '-')}`;
