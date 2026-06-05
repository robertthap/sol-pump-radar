import type { ReactNode } from "react";

type Props = {
  title: string;
  description: string;
  children: ReactNode;
  actions?: ReactNode;
};

/** Consistent header for advanced sidebar tools. */
export function AdvancedPageShell({ title, description, children, actions }: Props) {
  return (
    <main className="app-page">
      <section className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </section>
      {children}
    </main>
  );
}
