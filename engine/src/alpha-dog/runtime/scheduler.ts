export type ScheduleSlot = { id: string; label: string; interval: number; prompt: string; registryTags: string[]; allowedModes: string[]; tokenBudget?: number }
export function dueSlots(round: number, schedule: { slots: ScheduleSlot[]; simultaneousOrder: string[] }) {
  const order = new Map(schedule.simultaneousOrder.map((id, index) => [id, index]))
  return schedule.slots.filter((slot) => round % slot.interval === 0).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
}
