export function dueSlots(round, schedule) {
    const order = new Map(schedule.simultaneousOrder.map((id, index) => [id, index]));
    return schedule.slots.filter((slot) => round % slot.interval === 0).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
}
