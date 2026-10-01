import { createNativeStackNavigator } from '@react-navigation/native-stack';
import RoleSelectionScreen from '../screens/auth/RoleSelectionScreen';
import LoginScreen from '../screens/auth/LoginScreen';
import HomeownerDashboardScreen from '../screens/homeowner/HomeownerDashboardScreen';
import ProviderNavigator from './ProviderNavigator';
import { useAuth } from '../components/auth/AuthContext';
import { ProviderModuleProvider } from '../components/provider/ProviderContext';
import { Button, Notice, Page } from '../components/provider/ProviderUI';
import { MutationState } from '../components/provider/ProviderDataState';
import { useProviderMutation } from '../utils/useProviderData';
import type { RootStackParamList } from './rootTypes';
const Stack = createNativeStackNavigator<RootStackParamList>();
function ProviderFlow() {
  const { user } = useAuth();
  if (user?.role !== 'provider') return null;
  // Preserve the existing shared request queue; identity is used for new records.
  return <ProviderModuleProvider key={user.uid} authenticatedProviderId={user.uid}><ProviderNavigator /></ProviderModuleProvider>;
}
function TechnicianPending() {
  const { logout } = useAuth(), mutation = useProviderMutation();
  return <Page title="Technician"><Notice text="Technician module is not connected yet." /><MutationState {...mutation} /><Button title="Log out" disabled={mutation.pending} onPress={() => { void mutation.run(logout, ''); }} /></Page>;
}
export default function RootNavigator() {
  const { user } = useAuth();
  return <Stack.Navigator screenOptions={{ headerShown: false }}>
    {!user ? <Stack.Group navigationKey="signed-out"><Stack.Screen name="RoleSelection" component={RoleSelectionScreen} /><Stack.Screen name="Login" component={LoginScreen} /></Stack.Group>
      : user.role === 'provider' ? <Stack.Screen navigationKey={user.uid} name="ProviderFlow" component={ProviderFlow} />
      : user.role === 'homeowner' ? <Stack.Screen navigationKey={user.uid} name="HomeownerDashboard" component={HomeownerDashboardScreen} />
      : <Stack.Screen navigationKey={user.uid} name="TechnicianPending" component={TechnicianPending} />}
  </Stack.Navigator>;
}
