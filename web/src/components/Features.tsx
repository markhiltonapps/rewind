const TILES = [
  ['🎙️', 'Auto-record', 'Starts and stops itself. One clean recording per meeting.'],
  ['📝', 'Transcripts', 'Accurate, timestamped, and fully searchable.'],
  ['✨', 'AI summaries', 'Decisions and action items, generated for you.'],
  ['🔒', 'Private by design', 'Recordings stay on your PC. You own your data.'],
  ['🔎', 'Instant recall', 'Search across every past meeting in seconds.'],
  ['⚡', 'Zero setup', 'Install, sign in, done. No bots, no calendar links.'],
];
export function Features() {
  return (
    <section id="features" className="mx-auto max-w-5xl px-6 py-14 border-t border-rwline">
      <div className="text-xs uppercase tracking-[0.18em] text-rwtext3">Features</div>
      <h2 className="mt-3 text-2xl font-bold">Everything, remembered.</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {TILES.map(([ic, t, d]) => (
          <div key={t} className="rounded-xl border border-rwline bg-rwpanel p-4">
            <div className="mb-2 grid h-8 w-8 place-items-center rounded-lg bg-[#1c2b4d]">{ic}</div>
            <b>{t}</b><p className="text-rwtext2 text-sm leading-relaxed">{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
