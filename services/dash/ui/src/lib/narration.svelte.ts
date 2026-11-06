// Spoken's quest narration (services/dash/src/spoken.rs): one line plays at a time, page-wide.
// The packs are Ogg Vorbis, which Chrome and Firefox play; where the browser can't (older Safari),
// the play buttons stay hidden.

export interface Narration {
	url: string;
	/** Seconds, from the pack's length table. */
	length: number;
}

class Narrator {
	/** The line playing or paused, if any. */
	url = $state<string | null>(null);
	playing = $state(false);
	/** Seconds into the current line. */
	at = $state(0);
	#audio: HTMLAudioElement | null = null;

	readonly supported: boolean = typeof Audio !== 'undefined' && new Audio().canPlayType('audio/ogg; codecs="vorbis"') !== '';

	#el(): HTMLAudioElement {
		if (!this.#audio) {
			const a = new Audio();
			a.preload = 'none';
			a.addEventListener('play', () => (this.playing = true));
			a.addEventListener('pause', () => (this.playing = false));
			a.addEventListener('ended', () => {
				this.playing = false;
				this.url = null;
				this.at = 0;
			});
			a.addEventListener('timeupdate', () => (this.at = a.currentTime));
			a.addEventListener('error', () => {
				this.playing = false;
				this.url = null;
			});
			this.#audio = a;
		}
		return this.#audio;
	}

	/** Play `n`, or pause/resume it when it is the current line. */
	toggle(n: Narration) {
		const a = this.#el();
		if (this.url === n.url) {
			if (a.paused) void a.play();
			else a.pause();
			return;
		}
		this.url = n.url;
		this.at = 0;
		a.src = n.url;
		void a.play().catch(() => (this.playing = false));
	}

	stop() {
		this.#audio?.pause();
		this.url = null;
		this.at = 0;
	}
}

export const narrator = new Narrator();

/** "0:34" */
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
