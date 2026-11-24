import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography
} from '@mui/material';
import type { AuthState } from '../../shared/types';
import logoUrl from '../assets/logo.png';

interface AuthScreenProps {
  currentVersion: string;
  initialNotice?: string;
  onAuthenticated: (state: AuthState) => void;
}

export function AuthScreen({ currentVersion, initialNotice, onAuthenticated }: AuthScreenProps) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Login fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Register fields
  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [tenantName, setTenantName] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const state = await window.tai.authLogin({ username: username.trim(), password });
      onAuthenticated(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (regPassword.length < 6) {
      setError('Mật khẩu cần tối thiểu 6 ký tự.');
      return;
    }
    setSubmitting(true);
    try {
      const state = await window.tai.authRegister({
        email: email.trim(),
        password: regPassword,
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        tenantName: tenantName.trim() || undefined
      });
      onAuthenticated(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        height: '100%',
        width: '100%',
        display: 'grid',
        placeItems: 'center',
        background: 'radial-gradient(circle at 50% 0%, #15233a 0%, #0b1018 60%)',
        p: 3,
        overflow: 'auto'
      }}
    >
      <Paper
        variant="outlined"
        sx={{
          width: '100%',
          maxWidth: 440,
          p: 4,
          borderRadius: 4,
          bgcolor: 'rgba(20, 28, 40, 0.94)',
          borderColor: 'rgba(152, 186, 255, 0.22)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.55)'
        }}
      >
        <Stack sx={{ alignItems: 'center', mb: 3, gap: 1.2 }}>
          <Box
            component="img"
            src={logoUrl}
            alt="TAI Desktop logo"
            sx={{
              width: 72,
              height: 72,
              borderRadius: 3.5,
              objectFit: 'cover',
              border: '1px solid rgba(152, 186, 255, 0.35)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)'
            }}
          />
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.01em' }}>
            TAI Desktop
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            Lồng tiếng AI thời gian thực cho YouTube {currentVersion ? `· v${currentVersion}` : ''}
          </Typography>
        </Stack>

        <Tabs
          value={tab}
          onChange={(_e, val) => { setTab(val); setError(''); }}
          variant="fullWidth"
          sx={{ mb: 2.5, borderBottom: '1px solid #263242' }}
        >
          <Tab value="login" label="Đăng nhập" />
          <Tab value="register" label="Đăng ký mới" />
        </Tabs>

        {initialNotice && !error && (
          <Alert severity="info" sx={{ mb: 2 }}>{initialNotice}</Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>
        )}

        {tab === 'login' ? (
          <Stack component="form" onSubmit={e => void handleLogin(e)} sx={{ gap: 2 }}>
            <TextField
              label="Email hoặc tên đăng nhập"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              required
              fullWidth
              disabled={submitting}
            />
            <TextField
              label="Mật khẩu"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              fullWidth
              disabled={submitting}
            />
            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={submitting || !username.trim() || !password}
              sx={{ py: 1.25, mt: 0.5 }}
            >
              {submitting ? <CircularProgress size={22} color="inherit" /> : 'Đăng nhập'}
            </Button>
          </Stack>
        ) : (
          <Stack component="form" onSubmit={e => void handleRegister(e)} sx={{ gap: 1.8 }}>
            <Stack direction="row" sx={{ gap: 1.5 }}>
              <TextField
                label="Họ"
                value={lastName}
                onChange={e => setLastName(e.target.value)}
                fullWidth
                disabled={submitting}
              />
              <TextField
                label="Tên"
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
                required
                fullWidth
                disabled={submitting}
              />
            </Stack>
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              fullWidth
              disabled={submitting}
            />
            <TextField
              label="Mật khẩu (tối thiểu 6 ký tự)"
              type="password"
              value={regPassword}
              onChange={e => setRegPassword(e.target.value)}
              required
              fullWidth
              disabled={submitting}
            />
            <TextField
              label="Tên không gian làm việc (tùy chọn)"
              placeholder="Ví dụ: Cá nhân / Team Marketing"
              value={tenantName}
              onChange={e => setTenantName(e.target.value)}
              fullWidth
              disabled={submitting}
            />
            <Typography variant="caption" color="text.secondary">
              Tài khoản mới được tự động tạo không gian làm việc và kích hoạt gói Miễn phí hàng tháng.
            </Typography>
            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={submitting || !email.trim() || !firstName.trim() || !regPassword}
              sx={{ py: 1.25 }}
            >
              {submitting ? <CircularProgress size={22} color="inherit" /> : 'Tạo tài khoản & Bắt đầu'}
            </Button>
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
