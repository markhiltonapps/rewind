const STEPS = [
  ['It detects your meeting.', 'The moment a Teams or Meet call starts, Rewind quietly begins recording. No "start" button to forget.'],
  ['It transcribes every word.', 'Speech becomes an accurate, searchable transcript — processed securely in the cloud, tied to your account.'],
  ['It hands you the summary.', 'Key points, decisions, and action items — written up and waiting when the call ends.'],
];
export function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-5xl px-6 py-14">
      <div className="text-xs uppercase tracking-[0.18em] text-rwtext3">How it works</div>
      <h2 className="mt-3 text-2xl font-bold">From call to summary, automatically.</h2>
      <div className="mt-6 space-y-5">
        {STEPS.map(([t, d], i) => (
          <div key={i} className="flex gap-3">
            <span className="flex-none grid h-7 w-7 place-items-center rounded-full bg-[#1c2b4d] text-[#8fb4ff] text-sm font-bold">{i + 1}</span>
            <div><b>{t}</b><p className="text-rwtext2 leading-relaxed">{d}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}
