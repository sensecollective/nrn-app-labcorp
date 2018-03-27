#!/usr/bin/env bash

set -e

if [ "$#" -ne 6 ]; then
    echo "Usage: $0 <service account filename> <project> <cluster project> <cluster name> <cluster zone> <tag>"
    exit 1
fi

SERVICE_ACCOUNT_FILENAME=$1
PROJECT=$2
CLUSTER_PROJECT=$3
CLUSTER_NAME=$4
CLUSTER_ZONE=$5
TAG=$6

docker push docai/$PROJECT
gcloud auth activate-service-account --key-file=$SERVICE_ACCOUNT_FILENAME
gcloud container clusters get-credentials $CLUSTER_NAME \
  --zone $CLUSTER_ZONE \
  --project $CLUSTER_PROJECT
kubectl set image deployment/$PROJECT $PROJECT=docai/$PROJECT:$TAG
