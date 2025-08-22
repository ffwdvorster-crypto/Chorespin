// docs/parentSeedButton.js
// Adds a 'Load Starter Pack' button for ADULT users on pages that include this script.
// Call initParentSeedButton(getActiveHouseholdId) with a function that returns the current householdId.
export function initParentSeedButton(getActiveHouseholdId, supabase) {
  const container = document.querySelector('[data-parent-controls]') || document.body;
  const btn = document.createElement('button');
  btn.id = 'seedBtn';
  btn.textContent = 'Load Starter Pack';
  btn.style.padding = '10px 14px';
  btn.style.borderRadius = '10px';
  btn.style.border = '1px solid #ccc';
  btn.style.cursor = 'pointer';
  btn.style.margin = '8px 0';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Seeding...';
    try {
      const householdId = await getActiveHouseholdId();
      if (!householdId) throw new Error('No household selected');
      const mod = await import('./seedHelpers.js');
      await mod.seedDefaultsForHousehold(supabase, householdId);
      alert('Default chores and rewards loaded!');
    } catch (e) {
      alert('Error: ' + (e?.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Load Starter Pack';
    }
  });
  container.appendChild(btn);
}
