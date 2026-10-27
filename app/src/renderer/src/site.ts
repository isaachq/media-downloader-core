import type {SiteLabel} from '../../shared/sites'
import type {Translate} from './i18n'

export type {SiteLabel} from '../../shared/sites'

/** The name of a site ("YouTube", "VK", "Website"…): brands stay brands, "web" and "file" are translated. */
export const siteName = (t: Translate, site: SiteLabel): string => t(`site.${site}`)
