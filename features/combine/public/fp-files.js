// Saved Fantasy Points files — the picker shared by the Underdog upload page
// and Pay Dirt, so the weekly export is entered once and both pages use it.
// One copy on purpose: two pickers would drift and the pages would disagree
// about which file is "this week's".
//
//   FpFiles.mount({
//     select, file, note, forget,   elements: saved-file <select>, <input type=file>,
//                                   a note <span>, an optional Delete button
//     projectionsOnly,              list only files with an FPTS column (Pay Dirt)
//     onPick(saved | null),         saved = { id, name, rankings, nfl_week, season,
//                                   row_count, file_modified, created_at }
//   })
//
// Choosing a new file saves it straight away (the server returns the stored copy
// when the identical file was saved before) and picks it. Needs app.js.
var FpFiles = (function () {
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('Could not read ' + file.name)); };
      r.readAsText(file);
    });
  }

  // When this version of the file is from: the file's own timestamp (Fantasy
  // Points re-publishes over a weekend, and every update has the same name),
  // else when it was saved. "Sun 9:30 AM" within the week, a date beyond it.
  function when(s) {
    var d = new Date((s && (s.file_modified || s.created_at)) || '');
    if (isNaN(d.getTime())) return '';
    var recent = Math.abs(Date.now() - d.getTime()) < 6 * 864e5;
    return d.toLocaleString(undefined, recent
      ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function describe(s) {
    return (s.nfl_week ? 'Week ' + s.nfl_week + ' · ' : '') + when(s) + ' · ' + s.name;
  }

  function mount(opts) {
    var sel = opts.select;

    async function load(selectId) {
      var files = await apiFetch('/api/combine/rankings-files' + (opts.projectionsOnly ? '?projections=1' : ''))
        .catch(function () { return []; });
      sel.textContent = '';
      var none = document.createElement('option');
      none.value = '';
      none.textContent = files.length ? 'Choose a saved Fantasy Points file…' : 'No Fantasy Points file saved yet — choose one below';
      sel.appendChild(none);
      files.forEach(function (s, i) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = describe(s) + (i === 0 && files.length > 1 ? ' — newest' : '');
        sel.appendChild(o);
      });
      // The newest file is this week's, so it is picked without being asked.
      var want = selectId || (files.length ? files[0].id : '');
      sel.value = want ? String(want) : '';
      await pick();
    }

    async function pick() {
      if (opts.forget) opts.forget.hidden = !sel.value;
      if (!sel.value) { opts.note.textContent = ''; opts.onPick(null); return; }
      var s = await apiFetch('/api/combine/rankings-files/' + sel.value);
      opts.note.textContent = 'Using ' + describe(s) + ' — ' + (s.row_count || 0) + ' rows. Shared by the Underdog upload and Pay Dirt.';
      opts.onPick(s);
    }

    sel.addEventListener('change', function () { pick().catch(function () {}); });

    opts.file.addEventListener('change', async function () {
      var f = this.files[0];
      if (!f) return;
      var text;
      try { text = await readFile(f); } catch (e) { showError(e.message); return; }
      try {
        opts.note.textContent = f.name + ' — saving…';
        var saved = await apiPost('/api/combine/rankings-files', {
          rankings: text, name: f.name.replace(/\.(csv|tsv|txt)$/i, ''), file_modified: f.lastModified || null,
        });
        this.value = '';
        if (opts.projectionsOnly && !saved.has_projections) {
          opts.note.textContent = '';
          showError(f.name + ' has no FPTS (projected points) column, so Pay Dirt cannot use it. Download Fantasy Points\' weekly projections export.');
          return;
        }
        toast('Saved ' + saved.name + ' — the Underdog page and Pay Dirt both have it now');
        await load(saved.id);
      } catch (e) {
        // Couldn't save (the banner says why) — still use the file for this
        // visit, so a save failure never blocks the build in front of the owner.
        this.value = '';
        sel.value = '';
        if (opts.forget) opts.forget.hidden = true;
        opts.note.textContent = 'Using ' + f.name + ' for now — it was not saved, so the other page will not see it.';
        opts.onPick({ id: null, name: f.name, rankings: text, file_modified: f.lastModified || null });
      }
    });

    if (opts.forget) {
      opts.forget.addEventListener('click', async function () {
        if (!sel.value || !confirm('Delete this saved Fantasy Points file? Both pages lose it.')) return;
        await apiPost('/api/combine/rankings-files/' + sel.value, {}, 'DELETE');
        toast('Deleted');
        await load();
      });
    }

    return { load: load };
  }

  return { mount: mount, when: when };
})();
