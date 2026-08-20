import { ComingSoon, IconCamera } from '../ui'

export default function ProofCapture() {
  return (
    <ComingSoon
      eyebrow="Step 4"
      title="Proof capture"
      blurb="In-app camera only. 1–3 photos, capture time stamped client-side."
      section="spec 4.4"
      icon={<IconCamera className="h-7 w-7" />}
    />
  )
}
