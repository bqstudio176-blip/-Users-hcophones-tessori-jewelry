import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-6">
      <div className="text-center">
        <p className="text-xs font-medium uppercase tracking-widest text-accent">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-fg">Page not found</h1>
        <p className="mt-2 text-sm text-fg-muted">The page you are looking for does not exist or you do not have access.</p>
        <ButtonLink href="/dashboard" variant="outline" className="mt-6">Go to overview</ButtonLink>
      </div>
    </main>
  );
}
