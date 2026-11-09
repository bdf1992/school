import { Classroom } from "@/components/school/classroom";
import { SidebarToggle } from "@/components/sidebar";

export default function ClassroomPage() {
	return <Classroom navigation={<SidebarToggle />} />;
}
