import { ComingSoon, IconShield } from '../ui'

export default function VerificationResult() {
  return (
    <ComingSoon
      eyebrow="Step 5"
      title="Verification result"
      blurb="Verified, Rejected, or one follow-up question."
      section="spec 4.5"
      icon={<IconShield className="h-7 w-7" />}
    />
  )
}
