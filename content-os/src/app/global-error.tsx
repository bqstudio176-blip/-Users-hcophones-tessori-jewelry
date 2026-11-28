"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" data-theme="dark">
      <body style={{ background: "#0a0a0d", color: "#ededf2", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", textAlign: "center" }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600 }}>Content OS is temporarily unavailable</h1>
            <p style={{ opacity: 0.7, fontSize: 14 }}>An unexpected error occurred. Please try again.</p>
            <button onClick={reset} style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8, background: "#8b70ff", color: "#fff", border: 0 }}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
