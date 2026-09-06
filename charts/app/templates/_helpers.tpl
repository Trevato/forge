{{/*
The platform names an app's namespace <owner>--<app>--<env>, and reaches each
env at one host: <app>-<owner>.<domain> for prod, <env>-<app>-<owner>.<domain>
for a pull-request preview. The chart derives the env from the namespace so a
preview knows its own public address (the forge rebuilds every request URL on
it) without any per-env values.
*/}}
{{- define "forge.env" -}}
{{- regexReplaceAll "^.*--" .Release.Namespace "" -}}
{{- end -}}

{{- define "forge.url" -}}
{{- $env := include "forge.env" . -}}
{{- if eq $env "prod" -}}
{{- .Values.forge.url -}}
{{- else -}}
{{- printf "https://%s-%s" $env (regexReplaceAll "^https://" .Values.forge.url "") -}}
{{- end -}}
{{- end -}}

{{/* SSH is a single raw-TCP surface on the platform edge: prod owns it. */}}
{{- define "forge.ssh" -}}
{{- if eq (include "forge.env" .) "prod" -}}true{{- end -}}
{{- end -}}
