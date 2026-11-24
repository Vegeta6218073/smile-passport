import { requireMember } from '@/lib/auth';
import EnrolForm from './EnrolForm';

export default async function SecurityPage() {
  await requireMember({ allowUnenrolled: true });
  return <EnrolForm />;
}
