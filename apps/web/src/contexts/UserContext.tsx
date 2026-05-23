import { createContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { UserInfo, UserSettingsResponse } from '@repo/types';
import { appSettingsService, userService, userSettingsService } from '@/services';

export interface UserContextValue {
  user: UserInfo | null;
  databricksHost: string | null;
  claudeAgentSdkVersion: string | null;
  claudeCodeVersion: string | null;
  appTitle: string;
  welcomeHeading: string;
  githubAppId: string | null;
  modelSettings: UserSettingsResponse | null;
  isLoading: boolean;
  isAdmin: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  refetchAppSettings: () => Promise<void>;
  refetchModelSettings: () => Promise<void>;
}

export const UserContext = createContext<UserContextValue | null>(null);

interface UserProviderProps {
  children: ReactNode;
}

export function UserProvider({ children }: UserProviderProps) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [databricksHost, setDatabricksHost] = useState<string | null>(null);
  const [claudeAgentSdkVersion, setClaudeAgentSdkVersion] = useState<string | null>(null);
  const [claudeCodeVersion, setClaudeCodeVersion] = useState<string | null>(null);
  const [appTitle, setAppTitle] = useState('');
  const [welcomeHeading, setWelcomeHeading] = useState('');
  const [githubAppId, setGithubAppId] = useState<string | null>(null);
  const [modelSettings, setModelSettings] = useState<UserSettingsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAppSettings = useCallback(async () => {
    try {
      const data = await appSettingsService.getPublicSettings();
      setAppTitle(data.app_title);
      setWelcomeHeading(data.welcome_heading);
      setGithubAppId(data.github_app_id);
      document.title = data.app_title;
    } catch (err) {
      console.error('Failed to fetch app settings:', err);
      // Keep document.title as the static HTML <title> value
    }
  }, []);

  const fetchModelSettings = useCallback(async () => {
    const settings = await userSettingsService.getSettings();
    setModelSettings(settings);
  }, []);

  const fetchUser = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const data = await userService.getCurrentUser();
      setUser(data.user);
      setDatabricksHost(data.databricks_host);
      setClaudeAgentSdkVersion(data.claude_agent_sdk_version);
      setClaudeCodeVersion(data.claude_code_version);
      void fetchModelSettings().catch(err => {
        console.error('Failed to fetch model settings:', err);
        setModelSettings(null);
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('Failed to fetch user:', error);
      setError(error);
      setUser(null);
      setDatabricksHost(null);
      setClaudeAgentSdkVersion(null);
      setClaudeCodeVersion(null);
      setModelSettings(null);
    } finally {
      setIsLoading(false);
    }
  }, [fetchModelSettings]);

  useEffect(() => {
    fetchUser();
    fetchAppSettings();
  }, [fetchUser, fetchAppSettings]);

  return (
    <UserContext.Provider
      value={{
        user,
        databricksHost,
        claudeAgentSdkVersion,
        claudeCodeVersion,
        appTitle,
        welcomeHeading,
        githubAppId,
        modelSettings,
        isLoading,
        isAdmin: user?.is_admin ?? false,
        error,
        refetch: fetchUser,
        refetchAppSettings: fetchAppSettings,
        refetchModelSettings: fetchModelSettings,
      }}
    >
      {children}
    </UserContext.Provider>
  );
}
