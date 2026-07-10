-- 019_league_profiles_migrate: seed the multi-league list (settings
-- 'league.profiles' + 'league.active') from the legacy single
-- 'league.profile' so every consumer can rely on the plural key existing —
-- no feature should need a legacy fallback, and the owner shouldn't have to
-- re-enter his league on the hub for defaults to work. The legacy key is
-- kept (read-only seed), matching the CLAUDE.md note.

INSERT INTO settings (key, value, updated_at)
SELECT 'league.profiles',
       jsonb_build_array(jsonb_build_object(
         'id', 'lg-legacy',
         'name', 'My league',
         'teams', COALESCE(NULLIF(s.value->>'teams', '')::int, 12),
         'scoring', COALESCE(NULLIF(s.value->>'scoring', ''), 'half'),
         'flex', 1,
         'superflex', COALESCE((s.value->>'superflex')::boolean, false),
         'te_premium', COALESCE((s.value->>'te_premium')::boolean, false),
         'auction', false
       )),
       now()
FROM settings s
WHERE s.key = 'league.profile'
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'league.profiles');

-- Whatever profiles list exists (just seeded or saved earlier), make sure a
-- default league is pointed at.
INSERT INTO settings (key, value, updated_at)
SELECT 'league.active', p.value->0->'id', now()
FROM settings p
WHERE p.key = 'league.profiles'
  AND jsonb_typeof(p.value) = 'array'
  AND jsonb_array_length(p.value) > 0
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'league.active');
