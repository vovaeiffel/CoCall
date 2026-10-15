// src/emoji.ts
// ============================================================
// Набор эмодзи для окна выбора в чате.
// ============================================================
import { t } from './i18n';
export interface EmojiCategory {
    /** Значок вкладки */
    icon: string;
    title: string;
    items: string[];
}

const split = (s: string): string[] => s.split(/\s+/).filter(Boolean);

export const EMOJI_CATEGORIES: EmojiCategory[] = [
    {
        icon: '😀', title: 'Смайлы',
        items: split('😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😍 🥰 😘 😋 😛 😜 🤪 😎 🤓 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 😶 😐 😑 😬 🙄 😯 😦 😮 😲 🥱 😴 🤤 😪 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 😈 👿 💀 ☠️ 💩 🤡 👻 👽 🤖'),
    },
    {
        icon: '👍', title: 'Жесты',
        items: split('👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🖐️ 🖖 👋 🤝 🙏 👏 🙌 🤲 💪 🫡 🫶 ✍️'),
    },
    {
        icon: '❤️', title: 'Сердца и символы',
        items: split('❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 🔥 ✨ ⭐ 🌟 💥 💫 💯 ✅ ❌ ❓ ❗ ⚠️ 🎉 🎊'),
    },
    {
        icon: '🎮', title: 'Игры и вещи',
        items: split('🎮 🕹️ 🎧 🎤 🎵 🎶 🏆 🥇 ⚽ 🏀 🎯 🎲 🧩 💻 🖥️ ⌨️ 🖱️ 📱 💡 🔊 🔇 📣 ⏰ 💰 🎁'),
    },
    {
        icon: '🍕', title: 'Еда и животные',
        items: split('🍕 🍔 🍟 🌭 🍿 🍩 🍪 🍰 🍺 🍻 ☕ 🥤 🍎 🍌 🍓 🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐸 🐵 🙈 🙉 🙊 🐧 🦄 🐢'),
    },
];
