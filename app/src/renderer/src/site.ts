import type {LinkSite} from '../../shared/contract'
import type {Translate} from './i18n'

/** What a tag names: a site, or a link straight to a media file of any other site. */
export type SiteLabel = LinkSite | 'file'

/** The name of a site ("YouTube", "VK", "Website"…): brands stay brands, "web" and "file" are translated. */
export const siteName = (t: Translate, site: SiteLabel): string => t(`site.${site}`)
