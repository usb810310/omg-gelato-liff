export const MEMBER_REWARD_OPTIONS = [
  { type: 'exclusive_cup', title: '獨享杯', pointsCost: 10, description: '獨享杯兌換券' },
  { type: 'duet', title: '雙重奏', pointsCost: 10, description: '雙重奏兌換券' },
  { type: 'exclusive_cup_half_off', title: '獨享杯·折價券5折', pointsCost: 5, description: '指定品項 5 折' },
  { type: 'duet_half_off', title: '雙重奏·折價券5折', pointsCost: 5, description: '指定品項 5 折' },
] as const;

export type MemberRewardType = (typeof MEMBER_REWARD_OPTIONS)[number]['type'];

export function isMemberRewardType(value: unknown): value is MemberRewardType {
  return typeof value === 'string'
    && MEMBER_REWARD_OPTIONS.some((reward) => reward.type === value);
}
