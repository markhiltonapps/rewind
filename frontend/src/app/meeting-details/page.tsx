"use client"
import { useSidebar } from "@/components/Sidebar/SidebarProvider";
import { useState, useEffect } from "react";
import { Transcript, Summary } from "@/types";
import PageContent from "./page-content";
import { useRouter } from "next/navigation";

interface MeetingDetailsResponse {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  transcripts: Transcript[];
}

const sampleSummary: Summary = {
  key_points: { title: "Key Points", blocks: [] },
  action_items: { title: "Action Items", blocks: [] },
  decisions: { title: "Decisions", blocks: [] },
  main_topics: { title: "Main Topics", blocks: [] }
};

export default function MeetingDetails() {
  const { currentMeeting } = useSidebar();
  const router = useRouter();
  const [meetingDetails, setMeetingDetails] = useState<MeetingDetailsResponse | null>(null);
  const [meetingSummary, setMeetingSummary] = useState<Summary|null>(null);
  const [error, setError] = useState<string | null>(null);
  // Phase 8 Task 9: bumping this counter forces the fetch effect below
  // to re-run. Used when an auto-summary job completes in the
  // background for the meeting the user is currently looking at.
  const [refreshCounter, setRefreshCounter] = useState(0);

  useEffect(() => {
    const onCompleted = (e: Event) => {
      const detail = (e as CustomEvent<{ meeting_id: string }>).detail;
      if (!detail) return;
      if (detail.meeting_id === currentMeeting?.id) {
        setRefreshCounter((c) => c + 1);
      }
    };
    window.addEventListener('neato-summary-completed', onCompleted);
    return () => {
      window.removeEventListener('neato-summary-completed', onCompleted);
    };
  }, [currentMeeting?.id]);

  // Reset states when currentMeeting changes
  useEffect(() => {
    setMeetingDetails(null);
    setMeetingSummary(null);
    setError(null);
  }, [currentMeeting?.id]);

  useEffect(() => {
    if (!currentMeeting?.id || currentMeeting.id === 'intro-call') {
      setError("No meeting selected");
      return;
    }

    const fetchMeetingDetails = async () => {
      try {
        const response = await fetch(`http://localhost:5167/get-meeting/${currentMeeting.id}`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error('Failed to fetch meeting details');
        }
        const data = await response.json();
        console.log('Meeting details:', data);
        setMeetingDetails(data);
      } catch (error) {
        console.error('Error fetching meeting details:', error);
        setError("Failed to load meeting details");
      }
    };

    const fetchMeetingSummary = async () => {
      try {
        const summaryResponse = await fetch(`http://localhost:5167/get-summary/${currentMeeting.id}`, {
          cache: 'no-store',
        });
        if (!summaryResponse.ok) {
          throw new Error('Failed to fetch meeting summary');
        }
        const summary = await summaryResponse.json();
        const summaryData = summary.data || {};
        const { MeetingName, ...restSummaryData } = summaryData;
        const formattedSummary = Object.entries(restSummaryData).reduce((acc: Summary, [key, section]: [string, any]) => {
          acc[key] = {
            title: section?.title || key,
            blocks: (section?.blocks || []).map((block: any) => ({
              ...block,
              type: 'bullet',
              color: 'default',
              content: block.content.trim()
            }))
          };
          return acc;
        }, {} as Summary);
        setMeetingSummary(formattedSummary);
      } catch (error) {
        console.error('Error fetching meeting summary:', error);
        // Don't set error state for summary fetch failure, just use sample summary
        setMeetingSummary(sampleSummary);
      }
    };

    fetchMeetingDetails();
    fetchMeetingSummary();
  }, [currentMeeting?.id, refreshCounter]);

  // if (error) {
  //   return (
  //     <div className="flex items-center justify-center h-screen">
  //       <div className="text-center">
  //         <p className="text-red-500 mb-4">{error}</p>
  //         <button
  //           onClick={() => router.push('/')}
  //           className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
  //         >
  //           Go Back
  //         </button>
  //       </div>
  //     </div>
  //   );
  // }

  if (!meetingDetails || !meetingSummary) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>;
  }

  return <PageContent meeting={meetingDetails} summaryData={meetingSummary} />;
}