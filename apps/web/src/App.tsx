import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { UserProvider } from '@/contexts/UserContext';
import { useUser } from '@/hooks/useUser';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';

function LoadingSkeleton() {
  return (
    <div className="flex h-screen w-screen bg-background">
      <div className="w-[420px] h-full border-r border-border p-4 space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-8 w-full" />
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
      <div className="flex-1 h-full p-4">
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  );
}

function AppContent() {
  const { isLoading } = useUser();

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  return (
    <Routes>
      <Route path="/" element={<AppLayout />} />
      <Route path="/skills" element={<AppLayout />} />
      <Route path="/agents" element={<AppLayout />} />
      <Route path="/mcp" element={<AppLayout />} />
      <Route path="/settings" element={<AppLayout />} />
      <Route path="/admin" element={<Navigate to="/admin/general" replace />} />
      <Route path="/admin/branding" element={<AppLayout />} />
      <Route path="/admin/general" element={<AppLayout />} />
      <Route path="/admin/git" element={<Navigate to="/admin/repo" replace />} />
      <Route path="/admin/repo" element={<AppLayout />} />
      <Route path="/admin/settings" element={<Navigate to="/admin/general" replace />} />
      <Route path="/admin/users" element={<AppLayout />} />
      <Route path="/sessions/:sessionId" element={<AppLayout />} />
    </Routes>
  );
}

function App() {
  return (
    <UserProvider>
      <AppContent />
      <Toaster />
    </UserProvider>
  );
}

export default App;
