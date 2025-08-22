// docs/seedHelpers.js - seed defaults for a household (ADULT only)
export async function seedDefaultsForHousehold(supabase, householdId) {
  if (!householdId) throw new Error('No householdId');
  const { error: choresErr } = await supabase.rpc('create_default_chores', { p_household_id: householdId });
  if (choresErr) throw choresErr;
  const { error: rewardsErr } = await supabase.rpc('create_default_rewards', { p_household_id: householdId });
  if (rewardsErr) throw rewardsErr;
  return true;
}
