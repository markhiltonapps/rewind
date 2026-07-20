export function Nav() {
  return (
    <nav className="mx-auto max-w-5xl px-6 pt-7 flex items-center justify-between text-sm">
      <span className="flex items-center gap-2 font-bold">
        <span className="inline-block h-3.5 w-3.5 rotate-45 rounded-[3px] bg-rw-accent" />
        Neato Rewind
      </span>
      <span className="flex gap-5 text-rwtext2">
        <a href="#how">How it works</a><a href="#features">Features</a><a href="#get">Sign in</a>
      </span>
    </nav>
  );
}
