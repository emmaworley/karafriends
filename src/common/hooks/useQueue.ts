import { useEffect, useState } from "react";
import { fetchQuery, graphql, requestSubscription } from "react-relay";

import environment from "../graphqlEnvironment";
import { useQueueQueueQuery } from "./__generated__/useQueueQueueQuery.graphql";
import { useQueueQueueSubscription } from "./__generated__/useQueueQueueSubscription.graphql";

type ElementType<T extends ReadonlyArray<unknown>> =
  T extends ReadonlyArray<
    infer ElementType // tslint:disable-line:no-shadowed-variable
  >
    ? ElementType
    : never;

const queueQuery = graphql`
  query useQueueQueueQuery {
    currentSong {
      ... on QueueItemInterface {
        __typename
        playtime
      }
    }

    queue {
      ... on QueueItemInterface {
        __typename
        songId
        name
        artistName
        playtime
        timestamp
        userIdentity {
          deviceId
          nickname
        }
      }
    }
  }
`;

const queueSubscription = graphql`
  subscription useQueueQueueSubscription {
    queueChanged {
      currentSong {
        ... on QueueItemInterface {
          __typename
          playtime
        }
      }

      newQueue {
        ... on QueueItemInterface {
          __typename
          songId
          name
          artistName
          playtime
          timestamp
          userIdentity {
            deviceId
            nickname
          }
        }
      }
    }
  }
`;

type CurrentSongStateType = useQueueQueueQuery["response"]["currentSong"];
type QueueStateType = useQueueQueueQuery["response"]["queue"];

function withETAs(currentSong: CurrentSongStateType, queue: QueueStateType) {
  const currentSongPlaytime = currentSong?.playtime || 0;

  const result = queue.reduce<
    [[ElementType<QueueStateType>, number][], number]
  >(
    ([results, totalETA], cur) => {
      const playtime = cur.playtime || 0;

      return [results.concat([[cur, totalETA]]), totalETA + playtime];
    },
    [[], currentSongPlaytime],
  );

  return result[0];
}

export default function useQueue() {
  const [queueState, setQueueState] = useState<
    [ElementType<QueueStateType>, number][]
  >([]);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useQueueQueueQuery>(environment, queueQuery, {}).subscribe({
        next: ({ currentSong, queue }: useQueueQueueQuery["response"]) =>
          setQueueState(withETAs(currentSong, queue)),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    const initialQuery = fetchQuery<useQueueQueueQuery>(
      environment,
      queueQuery,
      {},
    ).subscribe({
      next: ({ currentSong, queue }: useQueueQueueQuery["response"]) => {
        setQueueState(withETAs(currentSong, queue));
      },
    });

    const subscription = requestSubscription<useQueueQueueSubscription>(
      environment,
      {
        subscription: queueSubscription,
        variables: {},
        onNext: (response) => {
          if (response) {
            setQueueState(
              withETAs(
                response.queueChanged.currentSong,
                response.queueChanged.newQueue,
              ),
            );
          }
        },
      },
    );

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  return queueState;
}
