export type ScheduleSlot = {
    id: string;
    label: string;
    interval: number;
    prompt: string;
    registryTags: string[];
    allowedModes: string[];
    tokenBudget?: number;
};
export declare function dueSlots(round: number, schedule: {
    slots: ScheduleSlot[];
    simultaneousOrder: string[];
}): ScheduleSlot[];
