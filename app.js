const API = 'https://pokeapi.co/api/v2';
const ART = id => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
const MINI = id => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;
const GEN_RANGES = {
  1: [1,151], 2: [152,251], 3: [252,386], 4: [387,493], 5: [494,649],
  6: [650,721], 7: [722,809], 8: [810,905], 9: [906,1025], all: [1,1025]
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const titleCase = value => value.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
const pad = id => String(id).padStart(4, '0');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  list: [],
  cache: new Map(),
  round: 1,
  rounds: 10,
  score: 0,
  current: null,
  choices: [],
  answered: false,
  generation: 'all',
  libraryLimit: 40,
  audio: new Audio(),
  soundOn: true,
  waveformToken: 0,
  waveformFrame: null,
  advanceTimer: null,
  questionToken: 0,
  questionAdvanced: false,
  discoveryToken: 0,
  decodeContext: null,
  stats: loadStats()
};

function loadStats() {
  try {
    return Object.assign({ heard: 0, answered: 0, correct: 0, bestStreak: 0, currentStreak: 0, discovered: [], favorites: [], lastDay: null }, JSON.parse(localStorage.getItem('crydex-progress') || '{}'));
  } catch { return { heard: 0, answered: 0, correct: 0, bestStreak: 0, currentStreak: 0, discovered: [], favorites: [], lastDay: null }; }
}

function saveStats() {
  localStorage.setItem('crydex-progress', JSON.stringify(state.stats));
  renderProgress();
}

function buildWaveform() {
  const wave = $('#waveform');
  wave.innerHTML = Array.from({ length: 52 }, (_, index) => {
    const value = 12 + Math.abs(Math.sin(index * .78) * 24);
    return `<i style="--wave-scale:${value / 100}"></i>`;
  }).join('');
}

async function renderActualWaveform(url) {
  const token = ++state.waveformToken;
  const bars = $$('#waveform i');
  bars.forEach(bar => bar.classList.remove('is-played'));
  if (!url) return;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Cry audio unavailable');
    const buffer = await response.arrayBuffer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.decodeContext ||= new AudioContextClass();
    const decoded = await state.decodeContext.decodeAudioData(buffer.slice(0));
    if (token !== state.waveformToken) return;
    const samples = decoded.getChannelData(0);
    const segmentSize = Math.max(1, Math.floor(samples.length / bars.length));
    const peaks = bars.map((_, index) => {
      const start = index * segmentSize;
      const end = Math.min(samples.length, start + segmentSize);
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += Math.max(1, Math.floor(segmentSize / 160))) {
        peak = Math.max(peak, Math.abs(samples[sampleIndex]));
      }
      return peak;
    });
    const maxPeak = Math.max(...peaks, .01);
    bars.forEach((bar, index) => bar.style.setProperty('--wave-scale', Math.max(.08, peaks[index] / maxPeak).toFixed(3)));
  } catch {
    if (token === state.waveformToken) showToast('Using a simplified waveform for this cry.');
  }
}

function startWaveformProgress() {
  cancelAnimationFrame(state.waveformFrame);
  const bars = $$('#waveform i');
  bars.forEach(bar => bar.classList.remove('is-played'));
  const update = () => {
    const ratio = state.audio.duration ? state.audio.currentTime / state.audio.duration : 0;
    bars.forEach((bar, index) => bar.classList.toggle('is-played', index / bars.length <= ratio));
    if (!state.audio.paused && !state.audio.ended) state.waveformFrame = requestAnimationFrame(update);
  };
  update();
}

async function fetchPokemon(id) {
  if (state.cache.has(id)) return state.cache.get(id);
  const response = await fetch(`${API}/pokemon/${id}`);
  if (!response.ok) throw new Error('Pokémon data could not be loaded.');
  const data = await response.json();
  const pokemon = {
    id: data.id,
    name: titleCase(data.name),
    rawName: data.name,
    cry: data.cries?.latest || data.cries?.legacy,
    image: data.sprites?.other?.['official-artwork']?.front_default || ART(data.id),
    sprite: data.sprites?.front_default || MINI(data.id),
    gif: data.sprites?.other?.showdown?.front_default || null,
    types: data.types.map(item => item.type.name),
    height: data.height,
    weight: data.weight
  };
  state.cache.set(id, pokemon);
  return pokemon;
}

async function loadPokemonList() {
  try {
    const response = await fetch(`${API}/pokemon-species?limit=2000&offset=0`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    state.list = data.results.map(item => {
      const id = Number(item.url.match(/\/pokemon-species\/(\d+)\/$/)?.[1]);
      return { id, name: titleCase(item.name), rawName: item.name };
    }).filter(item => item.id);
  } catch {
    state.list = Array.from({ length: 1025 }, (_, i) => ({ id: i + 1, name: `Pokémon #${pad(i + 1)}`, rawName: '' }));
    showToast('Live Pokédex names unavailable. Check your connection.');
  }
  renderLibrary();
}

function randomIds(count, generation = state.generation, exclude = []) {
  const dynamicMax = state.list.length ? Math.max(...state.list.map(item => item.id)) : GEN_RANGES.all[1];
  const [min, max] = generation === 'all' ? [1, dynamicMax] : (GEN_RANGES[generation] || GEN_RANGES.all);
  const pool = Array.from({ length: max - min + 1 }, (_, index) => index + min).filter(id => !exclude.includes(id));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

async function newQuestion(reset = false) {
  clearTimeout(state.advanceTimer);
  state.questionToken += 1;
  state.questionAdvanced = false;
  stopCurrentAudioUI();
  if (!$('#discoveryOverlay').hidden) closeDiscovery(false);
  if (reset) { state.round = 1; state.score = 0; }
  $('#sessionComplete').hidden = true;
  $('#practiceStage').hidden = false;
  state.answered = false;
  $('#answerGrid').classList.remove('is-judged');
  $('#practiceStatus').textContent = '';
  $('#answerGrid').innerHTML = '<div class="answer-skeleton"></div>'.repeat(4);
  $('#roundLabel').textContent = `Sound ${state.round} of ${state.rounds}`;
  $('#roundProgress').style.transform = `scaleX(${state.round / state.rounds})`;
  $('#sessionScore').textContent = state.score;
  try {
    const ids = randomIds(4);
    const pokemon = await Promise.all(ids.map(fetchPokemon));
    state.current = pokemon[0];
    state.choices = pokemon.sort(() => Math.random() - .5);
    $('#practiceStage .recorder-topline span:first-child').textContent = `FIELD RECORDER / CRY ${pad(state.current.id)}`;
    renderAnswers();
    setAudio(state.current.cry);
    if (!reset && state.soundOn) await playCurrent(true);
  } catch (error) {
    $('#answerGrid').innerHTML = `<div class="empty-recent">Couldn’t tune into the Pokédex. Check your connection and try again.</div>`;
    $('#practiceStatus').innerHTML = '<button class="secondary-button" id="retryQuiz">Try again</button>';
    $('#retryQuiz')?.addEventListener('click', () => newQuestion(reset));
  }
}

function renderAnswers() {
  $('#answerGrid').innerHTML = state.choices.map((pokemon, index) => `
    <button class="answer-button answer-dock" data-id="${pokemon.id}" style="--answer-index:${index}">
      <span class="answer-main">
        <span class="answer-sprite"><img src="${pokemon.image}" alt="${pokemon.name}" /></span>
        <span class="answer-identity"><strong>${pokemon.name}</strong></span>
      </span>
      <svg class="answer-check" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 12 4 4 8-9"/></svg>
    </button>`).join('');
  $$('.answer-button').forEach(button => button.addEventListener('click', () => answerQuestion(Number(button.dataset.id))));
}

function setAudio(url) {
  state.audio.pause();
  state.audio.src = url || '';
  state.audio.load();
  renderActualWaveform(url);
}

function stopCurrentAudioUI() {
  state.audio.pause();
  cancelAnimationFrame(state.waveformFrame);
  $('#playCry')?.classList.remove('is-playing', 'is-engaging');
  $('.sound-deck')?.classList.remove('is-playing');
}

async function playCurrent(silentFailure = false) {
  if (!state.soundOn) { showToast('Turn sound on to hear the cry.'); return; }
  if (!state.current?.cry) { showToast('This cry is unavailable.'); return; }
  try {
    $('#playCry').classList.remove('is-engaging');
    void $('#playCry').offsetWidth;
    $('#playCry').classList.add('is-engaging');
    if (state.audio.src !== state.current.cry) setAudio(state.current.cry);
    state.audio.currentTime = 0;
    await state.audio.play();
    startWaveformProgress();
    $('#playCry').classList.add('is-playing');
    $('.sound-deck').classList.add('is-playing');
    state.stats.heard += 1;
    saveStats();
  } catch {
    $('#playCry').classList.remove('is-playing');
    $('.sound-deck').classList.remove('is-playing');
    if (!silentFailure) showToast('Audio could not play. Tap again or check your connection.');
  }
}

state.audio.addEventListener('ended', () => {
  cancelAnimationFrame(state.waveformFrame);
  $('#playCry').classList.remove('is-playing');
  $('.sound-deck').classList.remove('is-playing');
  $('#playDiscoveryCry')?.classList.remove('is-playing');
});

function answerQuestion(id) {
  if (state.answered || !state.current) return;
  primeAudioForAutoplay();
  state.answered = true;
  const correct = id === state.current.id;
  const isNewDiscovery = correct && !state.stats.discovered.includes(state.current.id);
  const answeredToken = state.questionToken;
  state.stats.answered += 1;
  $('#answerGrid').classList.add('is-judged');
  $$('.answer-button').forEach(button => {
    button.disabled = true;
    const buttonId = Number(button.dataset.id);
    if (buttonId === id) button.classList.add(correct ? 'correct' : 'wrong', 'is-selected');
  });
  if (correct) {
    state.score += 100;
    state.stats.correct += 1;
    state.stats.currentStreak += 1;
    state.stats.bestStreak = Math.max(state.stats.bestStreak, state.stats.currentStreak);
    state.stats.discovered = [state.current.id, ...state.stats.discovered.filter(item => item !== state.current.id)];
  } else {
    state.stats.currentStreak = 0;
  }
  $('#sessionScore').textContent = state.score;
  updateDailyStreak();
  saveStats();
  $('#practiceStatus').textContent = correct ? 'Correct choice.' : 'Not quite. Loading the next sound.';
  showToast(correct ? 'Correct choice!' : 'Not quite — try the next cry.', correct ? 'success' : 'error');
  if (isNewDiscovery) {
    state.discoveryToken = answeredToken;
    state.advanceTimer = window.setTimeout(showDiscovery, reducedMotion.matches ? 0 : 420);
  } else {
    state.advanceTimer = window.setTimeout(() => advanceQuestion(answeredToken), reducedMotion.matches ? 350 : 1350);
  }
}

function primeAudioForAutoplay() {
  if (!state.soundOn || !state.audio.src || !state.audio.paused) return;
  const previousVolume = state.audio.volume;
  state.audio.volume = 0;
  const permission = state.audio.play();
  permission?.then(() => {
    state.audio.pause();
    state.audio.currentTime = 0;
    state.audio.volume = previousVolume;
  }).catch(() => { state.audio.volume = previousVolume; });
}

function updateDailyStreak() {
  const today = new Date().toISOString().slice(0, 10);
  if (state.stats.lastDay !== today) state.stats.lastDay = today;
}

function showDiscovery() {
  const pokemon = state.current;
  if (!pokemon) return;
  const image = $('#discoveryImage');
  image.onerror = () => {
    image.onerror = null;
    image.src = pokemon.image;
    image.alt = `${pokemon.name} official artwork`;
    $('#discoveryFormat').textContent = 'Static record';
  };
  image.src = pokemon.gif || pokemon.image;
  image.alt = pokemon.gif ? `${pokemon.name} animated sprite` : `${pokemon.name} official artwork`;
  $('#discoveryFormat').textContent = pokemon.gif ? 'Animated record' : 'Static record';
  $('#discoveryNumber').textContent = `#${pad(pokemon.id)}`;
  $('#discoveryTitle').textContent = pokemon.name;
  $('#discoverySummary').textContent = `${pokemon.name} and its cry are now registered in your Pokédex.`;
  $('#discoveryType').textContent = pokemon.types.map(titleCase).join(' / ');
  $('#discoveryHeight').textContent = `${(pokemon.height / 10).toFixed(1)} m`;
  $('#discoveryWeight').textContent = `${(pokemon.weight / 10).toFixed(1)} kg`;
  $('#discoveryOverlay').hidden = false;
  document.body.classList.add('has-discovery-open');
  requestAnimationFrame(() => $('#discoveryOverlay').classList.add('is-open'));
  $('#continueDiscovery').focus({ preventScroll: true });
  if (state.soundOn && pokemon.cry) playDiscoveryCry();
}

function closeDiscovery(advance = true) {
  const overlay = $('#discoveryOverlay');
  overlay.classList.remove('is-open');
  document.body.classList.remove('has-discovery-open');
  state.audio.pause();
  $('#playDiscoveryCry').classList.remove('is-playing');
  window.setTimeout(() => { overlay.hidden = true; }, reducedMotion.matches ? 0 : 220);
  if (advance) state.advanceTimer = window.setTimeout(() => advanceQuestion(state.discoveryToken), reducedMotion.matches ? 0 : 180);
}

async function playDiscoveryCry() {
  if (!state.soundOn) { showToast('Turn sound on to hear the cry.'); return; }
  if (!state.current?.cry) { showToast('This cry is unavailable.'); return; }
  try {
    state.audio.pause();
    state.audio.src = state.current.cry;
    state.audio.currentTime = 0;
    await state.audio.play();
    $('#playDiscoveryCry').classList.add('is-playing');
    state.stats.heard += 1;
    saveStats();
  } catch { showToast('The cry could not play. Tap again to retry.'); }
}

function nextQuestion() {
  if (state.round >= state.rounds) {
    finishSession();
  } else {
    state.round += 1;
    newQuestion();
  }
}

function advanceQuestion(token) {
  if (token !== state.questionToken || state.questionAdvanced) return;
  state.questionAdvanced = true;
  nextQuestion();
}

function finishSession() {
  stopCurrentAudioUI();
  $('#practiceStage').hidden = true;
  $('#completeScore').textContent = `${state.score / 100} / ${state.rounds}`;
  $('#completeMessage').textContent = state.score >= 800 ? 'Excellent ear. Those cries are becoming second nature.' : state.score >= 500 ? 'Nice listening. Another round will lock them in.' : 'Every replay sharpens your ear. Keep exploring the sound library.';
  $('#sessionComplete').hidden = false;
  $('#sessionComplete').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}

function switchView(view) {
  const current = $('[data-view-panel]:not([hidden])')?.dataset.viewPanel;
  if (current === view) return;
  const applyView = () => {
    $$('[data-view-panel]').forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; panel.classList.toggle('is-active', panel.dataset.viewPanel === view); });
    $$('[data-view]').forEach(button => button.classList.toggle('is-active', button.dataset.view === view));
    history.replaceState(null, '', `#${view}`);
    if (view === 'library') renderLibrary();
    if (view === 'progress') renderProgress();
    window.scrollTo({ top: 0, behavior: 'auto' });
  };
  applyView();
  const panel = $(`[data-view-panel="${view}"]`);
  panel?.classList.remove('is-view-entering');
  void panel?.offsetWidth;
  panel?.classList.add('is-view-entering');
}

function getFilteredList() {
  const query = ($('#searchInput')?.value || '').trim().toLowerCase();
  const generation = $('#libraryGeneration')?.value || 'all';
  const dynamicMax = state.list.length ? Math.max(...state.list.map(item => item.id)) : GEN_RANGES.all[1];
  const [min, max] = generation === 'all' ? [1, dynamicMax] : (GEN_RANGES[generation] || GEN_RANGES.all);
  return state.list.filter(item => item.id >= min && item.id <= max && (!query || item.name.toLowerCase().includes(query) || String(item.id) === query.replace(/^#/, '')));
}

function renderLibrary() {
  if (!$('#pokemonList')) return;
  const list = getFilteredList();
  const visible = list.slice(0, state.libraryLimit);
  $('#libraryCount').textContent = `${list.length.toLocaleString()} Pokémon`;
  $('#pokemonList').innerHTML = visible.length ? visible.map(item => `
    <article class="pokemon-row">
      <span class="pokemon-id">#${pad(item.id)}</span>
      <img src="${MINI(item.id)}" alt="" loading="lazy" />
      <div><div class="pokemon-name">${item.name}</div>${state.stats.discovered.includes(item.id) ? '<span class="mastery-mark">Discovered</span>' : ''}</div>
      <button class="favorite-button ${state.stats.favorites.includes(item.id) ? 'is-favorite' : ''}" data-favorite="${item.id}" aria-label="${state.stats.favorites.includes(item.id) ? 'Remove from' : 'Add to'} favorites"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 20-1.5-1.35C5.2 13.9 2 11 2 7.5 2 4.6 4.2 2.5 7 2.5c1.6 0 3.1.75 4 1.95 1-1.2 2.4-1.95 4-1.95 2.8 0 5 2.1 5 5 0 3.5-3.2 6.4-8.5 11.15L12 20Z"/></svg></button>
      <button class="row-play" data-play-id="${item.id}" aria-label="Play ${item.name} cry"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6v12l10-6L9 6Z"/></svg></button>
    </article>`).join('') : '<div class="empty-recent">No Pokémon match that search.</div>';
  $('#loadMore').hidden = visible.length >= list.length;
  $$('[data-play-id]').forEach(button => button.addEventListener('click', () => playLibraryPokemon(Number(button.dataset.playId), button)));
  $$('[data-favorite]').forEach(button => button.addEventListener('click', () => toggleFavorite(Number(button.dataset.favorite))));
}

async function playLibraryPokemon(id, button) {
  if (!state.soundOn) { showToast('Turn sound on to hear the cry.'); return; }
  const original = button.innerHTML;
  button.innerHTML = '<span class="inline-loader" aria-hidden="true"></span>';
  try {
    const pokemon = await fetchPokemon(id);
    if (!pokemon.cry) throw new Error();
    state.audio.pause();
    state.audio.src = pokemon.cry;
    await state.audio.play();
    state.stats.heard += 1;
    saveStats();
    showToast(`Playing ${pokemon.name}`);
  } catch { showToast('That cry could not be played.'); }
  finally { button.innerHTML = original; }
}

function toggleFavorite(id) {
  state.stats.favorites = state.stats.favorites.includes(id) ? state.stats.favorites.filter(item => item !== id) : [...state.stats.favorites, id];
  saveStats();
  renderLibrary();
}

function renderProgress() {
  const accuracy = state.stats.answered ? Math.round((state.stats.correct / state.stats.answered) * 100) : 0;
  $('#accuracyValue').textContent = `${Math.min(accuracy, 100)}%`;
  $('#accuracyBar').style.transform = `scaleX(${Math.min(accuracy, 100) / 100})`;
  $('#heardStat').textContent = state.stats.heard;
  $('#correctStat').textContent = state.stats.correct;
  $('#streakStat').textContent = state.stats.bestStreak;
  $('#discoveredStat').textContent = state.stats.discovered.length;
  $('#sideStreak').textContent = `${state.stats.bestStreak} sound streak`;
  if (state.stats.correct) {
    $('#progressHeadline').textContent = `${state.stats.discovered.length} cries discovered.`;
    $('#progressCopy').textContent = `You’ve answered ${state.stats.correct} sounds correctly. Keep practicing to make each cry instantly recognizable.`;
  }
  const recent = state.stats.discovered.slice(0, 5);
  $('#recentList').innerHTML = recent.length ? recent.map(id => {
    const item = state.list.find(entry => entry.id === id);
    return `<div class="recent-card"><img src="${MINI(id)}" alt="" loading="lazy"><span>${item?.name || `#${pad(id)}`}</span></div>`;
  }).join('') : '<div class="empty-recent">No discoveries yet. Your first correct answer will appear here.</div>';
}

let toastTimer;
function showToast(message, tone = 'neutral') {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.remove('is-success', 'is-error');
  if (tone === 'success') $('#toast').classList.add('is-success');
  if (tone === 'error') $('#toast').classList.add('is-error');
  $('#toast').classList.add('is-visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('is-visible'), 2600);
}

function bindEvents() {
  $$('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $$('[data-go-practice]').forEach(button => button.addEventListener('click', () => switchView('practice')));
  $('#playCry').addEventListener('click', () => playCurrent());
  $('#playDiscoveryCry').addEventListener('click', playDiscoveryCry);
  $('#continueDiscovery').addEventListener('click', () => closeDiscovery());
  $('#closeDiscovery').addEventListener('click', () => closeDiscovery());
  $('#discoveryOverlay').addEventListener('click', event => { if (event.target === event.currentTarget) closeDiscovery(); });
  $('#practiceAgain').addEventListener('click', () => newQuestion(true));
  $('#reviewProgress').addEventListener('click', () => switchView('progress'));
  $('#generationSelect').addEventListener('change', event => { state.generation = event.target.value; newQuestion(true); });
  $('#soundToggle').addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    $('#soundToggle').setAttribute('aria-pressed', String(state.soundOn));
    $('#soundToggle').setAttribute('aria-label', `Sound is ${state.soundOn ? 'on' : 'off'}`);
    if (!state.soundOn) {
      state.audio.pause();
      $('#playCry').classList.remove('is-playing');
      $('.sound-deck').classList.remove('is-playing');
    }
  });
  $('#searchInput').addEventListener('input', () => { state.libraryLimit = 40; renderLibrary(); });
  $('#libraryGeneration').addEventListener('change', () => { state.libraryLimit = 40; renderLibrary(); });
  $('#loadMore').addEventListener('click', () => { state.libraryLimit += 40; renderLibrary(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#discoveryOverlay').hidden) { closeDiscovery(); return; }
    if (!$('#discoveryOverlay').hidden) {
      if (event.key === 'Tab') {
        const controls = $$('#discoveryOverlay button:not([disabled])');
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      return;
    }
    if (event.target.matches('input, select, button')) return;
    if (event.code === 'Space' && !$('#practiceView').hidden) { event.preventDefault(); playCurrent(); }
  });
}

async function init() {
  buildWaveform();
  bindEvents();
  renderProgress();
  const route = location.hash.replace('#', '');
  if (['practice','library','progress'].includes(route)) switchView(route);
  await Promise.all([loadPokemonList(), newQuestion(true)]);
}

init();
