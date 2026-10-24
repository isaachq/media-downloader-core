// The interface language: a select with search over the fourteen languages,
// each by its own name and by its name in the language shown now. Fourteen
// don't fit a segmented control. Arabic mirrors the window (App.tsx).
import {Select} from 'antd'
import {type Language, LANGUAGE_NAMES, LANGUAGES} from '../../../shared/contract'
import {useApp} from '../context'
import {useT} from '../i18n'

/** Every language's name in each language the app speaks (the option's second line, and what a search matches). */
const NAMES_IN: Readonly<Record<Language, Readonly<Record<Language, string>>>> = {
  es: {es: 'Español', en: 'Inglés', pt: 'Portugués', id: 'Indonesio', hi: 'Hindi', vi: 'Vietnamita', th: 'Tailandés', tr: 'Turco', ar: 'Árabe', fr: 'Francés', de: 'Alemán', ru: 'Ruso', zh: 'Chino', it: 'Italiano'},
  en: {es: 'Spanish', en: 'English', pt: 'Portuguese', id: 'Indonesian', hi: 'Hindi', vi: 'Vietnamese', th: 'Thai', tr: 'Turkish', ar: 'Arabic', fr: 'French', de: 'German', ru: 'Russian', zh: 'Chinese', it: 'Italian'},
  pt: {es: 'Espanhol', en: 'Inglês', pt: 'Português', id: 'Indonésio', hi: 'Hindi', vi: 'Vietnamita', th: 'Tailandês', tr: 'Turco', ar: 'Árabe', fr: 'Francês', de: 'Alemão', ru: 'Russo', zh: 'Chinês', it: 'Italiano'},
  id: {es: 'Spanyol', en: 'Inggris', pt: 'Portugis', id: 'Indonesia', hi: 'Hindi', vi: 'Vietnam', th: 'Thai', tr: 'Turki', ar: 'Arab', fr: 'Prancis', de: 'Jerman', ru: 'Rusia', zh: 'Mandarin', it: 'Italia'},
  hi: {es: 'स्पेनिश', en: 'अंग्रेज़ी', pt: 'पुर्तगाली', id: 'इंडोनेशियाई', hi: 'हिन्दी', vi: 'वियतनामी', th: 'थाई', tr: 'तुर्की', ar: 'अरबी', fr: 'फ़्रेंच', de: 'जर्मन', ru: 'रूसी', zh: 'चीनी', it: 'इतालवी'},
  vi: {es: 'Tiếng Tây Ban Nha', en: 'Tiếng Anh', pt: 'Tiếng Bồ Đào Nha', id: 'Tiếng Indonesia', hi: 'Tiếng Hindi', vi: 'Tiếng Việt', th: 'Tiếng Thái', tr: 'Tiếng Thổ Nhĩ Kỳ', ar: 'Tiếng Ả Rập', fr: 'Tiếng Pháp', de: 'Tiếng Đức', ru: 'Tiếng Nga', zh: 'Tiếng Trung', it: 'Tiếng Ý'},
  th: {es: 'ภาษาสเปน', en: 'ภาษาอังกฤษ', pt: 'ภาษาโปรตุเกส', id: 'ภาษาอินโดนีเซีย', hi: 'ภาษาฮินดี', vi: 'ภาษาเวียดนาม', th: 'ภาษาไทย', tr: 'ภาษาตุรกี', ar: 'ภาษาอาหรับ', fr: 'ภาษาฝรั่งเศส', de: 'ภาษาเยอรมัน', ru: 'ภาษารัสเซีย', zh: 'ภาษาจีน', it: 'ภาษาอิตาลี'},
  tr: {es: 'İspanyolca', en: 'İngilizce', pt: 'Portekizce', id: 'Endonezce', hi: 'Hintçe', vi: 'Vietnamca', th: 'Tayca', tr: 'Türkçe', ar: 'Arapça', fr: 'Fransızca', de: 'Almanca', ru: 'Rusça', zh: 'Çince', it: 'İtalyanca'},
  ar: {es: 'الإسبانية', en: 'الإنجليزية', pt: 'البرتغالية', id: 'الإندونيسية', hi: 'الهندية', vi: 'الفيتنامية', th: 'التايلاندية', tr: 'التركية', ar: 'العربية', fr: 'الفرنسية', de: 'الألمانية', ru: 'الروسية', zh: 'الصينية', it: 'الإيطالية'},
  fr: {es: 'Espagnol', en: 'Anglais', pt: 'Portugais', id: 'Indonésien', hi: 'Hindi', vi: 'Vietnamien', th: 'Thaï', tr: 'Turc', ar: 'Arabe', fr: 'Français', de: 'Allemand', ru: 'Russe', zh: 'Chinois', it: 'Italien'},
  de: {es: 'Spanisch', en: 'Englisch', pt: 'Portugiesisch', id: 'Indonesisch', hi: 'Hindi', vi: 'Vietnamesisch', th: 'Thailändisch', tr: 'Türkisch', ar: 'Arabisch', fr: 'Französisch', de: 'Deutsch', ru: 'Russisch', zh: 'Chinesisch', it: 'Italienisch'},
  ru: {es: 'Испанский', en: 'Английский', pt: 'Португальский', id: 'Индонезийский', hi: 'Хинди', vi: 'Вьетнамский', th: 'Тайский', tr: 'Турецкий', ar: 'Арабский', fr: 'Французский', de: 'Немецкий', ru: 'Русский', zh: 'Китайский', it: 'Итальянский'},
  zh: {es: '西班牙语', en: '英语', pt: '葡萄牙语', id: '印度尼西亚语', hi: '印地语', vi: '越南语', th: '泰语', tr: '土耳其语', ar: '阿拉伯语', fr: '法语', de: '德语', ru: '俄语', zh: '中文', it: '意大利语'},
  it: {es: 'Spagnolo', en: 'Inglese', pt: 'Portoghese', id: 'Indonesiano', hi: 'Hindi', vi: 'Vietnamita', th: 'Thailandese', tr: 'Turco', ar: 'Arabo', fr: 'Francese', de: 'Tedesco', ru: 'Russo', zh: 'Cinese', it: 'Italiano'},
}

/** Folded for a search: lower case, no accents ("portugues" finds "Português"). */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** What a search matches for a language: its own name, its name in every language, its code. O(languages). */
export const searchText = (code: Language): string => fold([LANGUAGE_NAMES[code], code, ...LANGUAGES.map(ui => NAMES_IN[ui][code])].join(' '))

/** The language select. `compact`: the header's small one. */
export function LanguageSelect({compact = false}: {compact?: boolean}) {
  const t = useT()
  const {settings, updateSettings} = useApp()
  return (
    <Select<Language>
      aria-label={t('header.language')}
      data-testid="language-select"
      size={compact ? 'small' : 'middle'}
      style={{minWidth: compact ? 150 : 240}}
      popupMatchSelectWidth={false}
      value={settings.language}
      showSearch={{filterOption: (input, option) => searchText(option?.value as Language).includes(fold(input))}}
      options={LANGUAGES.map(code => ({value: code, label: LANGUAGE_NAMES[code]}))}
      optionRender={option => (
        <span>
          {LANGUAGE_NAMES[option.value as Language]}{' '}
          <span style={{opacity: 0.6}}>· {NAMES_IN[settings.language][option.value as Language]}</span>
        </span>
      )}
      onChange={language => void updateSettings({language})}
    />
  )
}
