import { ComingSoon, IconChart } from '../ui'

export default function WeeklyReview() {
  return (
    <ComingSoon
      eyebrow="Sunday"
      title="Weekly review"
      blurb="Completion rate, minutes earned vs spent, tier overrides, late-added tasks."
      section="spec 4.7"
      icon={<IconChart className="h-7 w-7" />}
    />
  )
}
