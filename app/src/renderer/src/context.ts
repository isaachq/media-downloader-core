import {createContext, useContext} from 'react'
import type {AppInfo, AppSettings} from '../../shared/contract'

export type AppContextValue = {
  readonly info: AppInfo
  readonly settings: AppSettings
  readonly dark: boolean
  /** Persist a settings change (validated by the main process) and apply it. */
  readonly updateSettings: (patch: Partial<AppSettings>) => Promise<void>
}

export const AppContext = createContext<AppContextValue | undefined>(undefined)

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp() outside <AppContext.Provider>')
  return value
}
