import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArrowLeft,
  Blocks,
  Palette,
  PanelLeft,
  PanelLeftClose,
  Settings,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUser } from '@/hooks/useUser';
import { cn } from '@/lib/utils';
import { UserFooter } from './UserFooter';

interface AdminSidebarProps {
  collapsible?: 'offcanvas' | 'icon' | 'none';
}

interface AdminNavItem {
  icon: LucideIcon;
  label: string;
  path: string;
}

function AdminSidebarHeader() {
  const { t } = useTranslation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === 'collapsed';

  return (
    <div
      className={cn(
        'flex h-[50px] shrink-0 items-center',
        isCollapsed ? 'justify-center px-0' : 'justify-between px-4'
      )}
    >
      {isCollapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={toggleSidebar}
              aria-label={t('sidebar.openSidebar')}
              className="group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
            >
              <ShieldCheck className="h-5 w-5 shrink-0 group-hover:hidden" />
              <PanelLeft className="hidden h-5 w-5 shrink-0 group-hover:block" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('sidebar.openSidebar')}</TooltipContent>
        </Tooltip>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck className="h-5 w-5 shrink-0" />
            <span className="truncate font-semibold text-foreground">{t('admin.title')}</span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                aria-label={t('sidebar.closeSidebar')}
                className="h-8 w-8 shrink-0"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t('sidebar.closeSidebar')}</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

function AdminSidebarContent() {
  const { t } = useTranslation();
  const location = useLocation();

  const navItems: AdminNavItem[] = [
    { path: '/admin/general', label: t('admin.general'), icon: Settings },
    { path: '/admin/integration', label: t('admin.integration'), icon: Blocks },
    { path: '/admin/monitoring', label: t('admin.monitoring'), icon: Activity },
    { path: '/admin/branding', label: t('admin.branding'), icon: Palette },
    { path: '/admin/users', label: t('admin.userManagement'), icon: UsersRound },
  ];

  return (
    <>
      <SidebarGroup className="px-2 py-2">
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={t('admin.backToApp')}>
                <Link to="/">
                  <ArrowLeft className="h-4 w-4" />
                  <span>{t('admin.backToApp')}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="px-2 py-1">
        <SidebarGroupLabel>{t('admin.navigation')}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {navItems.map(item => {
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    isActive={location.pathname === item.path}
                    tooltip={item.label}
                  >
                    <Link to={item.path}>
                      <Icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

export function AdminSidebar({ collapsible = 'none' }: AdminSidebarProps) {
  const { user, databricksHost, isLoading, error, refetch } = useUser();

  return (
    <Sidebar collapsible={collapsible} className="border-r">
      <SidebarHeader className="p-0">
        <AdminSidebarHeader />
      </SidebarHeader>
      <SidebarContent>
        <AdminSidebarContent />
      </SidebarContent>
      <SidebarFooter className="p-0">
        <UserFooter
          userName={user?.name}
          databricksHost={databricksHost}
          isLoading={isLoading}
          error={error}
          onRetry={refetch}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
