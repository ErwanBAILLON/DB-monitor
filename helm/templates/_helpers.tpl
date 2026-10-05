{{/*
Expand the name of the chart.
*/}}
{{- define "db-monitor.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "db-monitor.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "db-monitor.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "db-monitor.labels" -}}
helm.sh/chart: {{ include "db-monitor.chart" . }}
{{ include "db-monitor.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "db-monitor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "db-monitor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "db-monitor.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "db-monitor.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Egress allowlist for the app (DBMON_ALLOWED_TARGETS), derived from networkPolicy.egress:
".<ns>.svc.cluster.local:5432/6379,..." plus any extra entries in networkPolicy.extraTargets.
*/}}
{{- define "db-monitor.allowedTargets" -}}
{{- $out := list -}}
{{- range .Values.networkPolicy.egress -}}
{{- $ports := list -}}
{{- range .ports }}{{ $ports = append $ports (toString .) }}{{ end -}}
{{- $out = append $out (printf ".%s.svc.cluster.local:%s" .namespace (join "/" $ports)) -}}
{{- end -}}
{{- range .Values.networkPolicy.extraTargets }}{{ $out = append $out . }}{{ end -}}
{{- join "," $out -}}
{{- end -}}

{{/* Directories the SQLite driver may open (DBMON_SQLITE_ROOTS). */}}
{{- define "db-monitor.sqliteRoots" -}}
{{- $out := list -}}
{{- if .Values.sqlite.sample }}{{ $out = append $out (dir .Values.sqlite.samplePath) }}{{ end -}}
{{- range .Values.sqlite.mounts }}{{ $out = append $out .mountPath }}{{ end -}}
{{- join "," $out -}}
{{- end -}}
