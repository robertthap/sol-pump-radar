// Worker/CLI typecheck augmentation:
// Next.js patches RequestInit with `next` at runtime via its plugin; the CLI
// tsconfig doesn't load the Next plugin, so we declare it here for shared
// modules under lib/ that pass { next: { revalidate, tags } } to fetch().
declare global {
  interface RequestInit {
    next?: {
      revalidate?: number | false;
      tags?: string[];
    };
  }
}
export {};
