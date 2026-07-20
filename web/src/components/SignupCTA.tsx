import { SignupForm } from '@/components/SignupForm';

export function SignupCTA() {
  return (
    <section id="get" className="bg-rw-hero px-6 py-16 text-center">
      <div className="mx-auto max-w-xl">
        <h2 className="text-3xl font-bold">Start remembering your meetings.</h2>
        <p className="mt-2 text-rwtext2">Enter your email to get instant access and the download.</p>
        <div className="mt-5"><SignupForm variant="cta" /></div>
        <p className="mt-3 text-xs text-rwtext3">Instant access · Free while in beta · Windows now, macOS soon</p>
      </div>
    </section>
  );
}
