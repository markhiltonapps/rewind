import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { Compat } from '@/components/Compat';
import { HowItWorks } from '@/components/HowItWorks';
import { Features } from '@/components/Features';
import { PrivacyBand } from '@/components/PrivacyBand';
import { SignupCTA } from '@/components/SignupCTA';
import { Footer } from '@/components/Footer';

export default function Home() {
  return (
    <main>
      <Nav /><Hero /><Compat /><HowItWorks /><Features /><PrivacyBand /><SignupCTA /><Footer />
    </main>
  );
}
