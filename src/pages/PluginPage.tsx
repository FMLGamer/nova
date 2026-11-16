import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { errorText, toast } from '../lib/store';
import type { ViewNode } from '../lib/types';
import { Rail } from '../components/media';
import { Button, Empty, Spinner } from '../components/ui';
import { MetaCard } from './PluginMeta';

/** Renders a plugin's declarative view tree with Nova's own components — plugins never inject markup. */
function Node({ node, pluginId }: { node: ViewNode; pluginId: string }) {
  const navigate = useNavigate();
  switch (node.type) {
    case 'stack':
      return (
        <div className="space-y-6">
          {node.children?.map((c, i) => (
            <Node key={i} node={c} pluginId={pluginId} />
          ))}
        </div>
      );
    case 'row':
      return (
        <div className="flex flex-wrap items-center gap-3">
          {node.children?.map((c, i) => (
            <Node key={i} node={c} pluginId={pluginId} />
          ))}
        </div>
      );
    case 'heading':
      return <h2 className="font-display text-2xl font-semibold">{node.text}</h2>;
    case 'text':
      return <p className="max-w-3xl leading-relaxed whitespace-pre-line text-muted">{node.text}</p>;
    case 'image':
      return node.url ? <img src={node.url} alt={node.text ?? ''} className="max-h-80 rounded-2xl" /> : null;
    case 'cards':
      return (
        <div className="-mx-5 sm:-mx-10">
          <Rail>
            {(node.items ?? []).map((m) => (
              <MetaCard key={m.id} pluginId={pluginId} meta={m} />
            ))}
          </Rail>
        </div>
      );
    case 'button':
      return (
        <Button
          variant="white"
          onClick={async () => {
            if (node.url) {
              if (node.url.startsWith('/')) navigate(node.url);
              else window.open(node.url, '_blank', 'noopener');
              return;
            }
            if (!node.action) return;
            try {
              const r = await api.plugins.action(pluginId, node.action);
              if (r.toast) toast(r.toast);
              if (r.navigate) navigate(r.navigate);
              if (r.openUrl) window.open(r.openUrl, '_blank', 'noopener');
            } catch (e) {
              toast(errorText(e), 'bad');
            }
          }}
        >
          {node.text}
        </Button>
      );
    default:
      return null;
  }
}

export default function PluginPage() {
  const { plugin = '', page = '' } = useParams();
  const [params] = useSearchParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['plugin-page', plugin, page, params.toString()],
    queryFn: () => api.plugins.page(plugin, page, Object.fromEntries(params)),
  });
  return (
    <div className="px-5 pt-24 pb-10 sm:px-10 sm:pt-28">
      {isLoading && <Spinner className="size-7" />}
      {error && <Empty title="This page didn't load">{errorText(error)}</Empty>}
      {data && <Node node={data} pluginId={plugin} />}
    </div>
  );
}
