import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/layout';
import { HomePage } from './pages/home';
import { LoginPage } from './pages/login';
import { SignupPage } from './pages/signup';
import { PostDetailPage } from './pages/post-detail';
import { AuthorDashboardPage } from './pages/author-dashboard';
import { AuthorProfilePage } from './pages/author-profile';
import { PostEditorPage } from './pages/post-editor';
import { ChatPage } from './pages/chat';
import { RequireAuth } from './components/require-auth';

export const App = () => (
  <Routes>
    <Route element={<Layout />}>
      <Route index element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/posts/:id" element={<PostDetailPage />} />
      <Route path="/authors/:id" element={<AuthorProfilePage />} />

      <Route element={<RequireAuth />}>
        <Route path="/chat" element={<ChatPage />} />
        <Route element={<RequireAuth role="author" />}>
          <Route path="/author" element={<AuthorDashboardPage />} />
          <Route path="/author/posts/new" element={<PostEditorPage />} />
          <Route path="/author/posts/:id/edit" element={<PostEditorPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  </Routes>
);
