# -*- coding: utf-8 -*-
"""Alpha Memory Qdrant vector integration module."""

from qdrant_client import QdrantClient, models
import urllib.request
import urllib.error
import hashlib
import ipaddress
import json
import os
import logging
from contextlib import contextmanager
from typing import List, Tuple
from urllib.parse import urlparse

from .fsutil import FileLock


logger = logging.getLogger(__name__)


class VectorIndex:
    """Qdrant 向量索引封装（支持批量操作、容错、日志）。"""
    
    def __init__(self, root_path, embedding_model="qwen3-embedding:0.6b", 
                 embedding_api="http://127.0.0.1:11434/v1",
                 auto_create_collection=True):
        self.root = root_path
        self.embedding_model = embedding_model
        self.embedding_api = embedding_api.rstrip("/")
        self._validate_embedding_api(self.embedding_api)
        self.dimensions = 1024
        self.collection = "alpha_memory"
        
        self.qdrant_path = os.path.join(root_path, "qdrant")
        self.lock_path = os.path.join(root_path, ".qdrant-access")
        self.client = None
        if auto_create_collection:
            with self._open_client() as client:
                self._ensure_collection(client)
        logger.info(f"VectorIndex initialized at {self.qdrant_path}")
    
    @staticmethod
    def _point_id(node_id: str) -> int:
        """Return a stable positive 63-bit Qdrant id for a node id."""
        digest = hashlib.sha256(str(node_id).encode("utf-8")).digest()
        return int.from_bytes(digest[:8], "big") & ((1 << 63) - 1)

    @staticmethod
    def _validate_embedding_api(api: str) -> None:
        """Only permit local embedding endpoints so memory content stays local."""
        parsed = urlparse(api)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("embedding_api must be an absolute HTTP(S) URL")
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            loopback = parsed.hostname.lower() == "localhost"
        if not loopback:
            raise ValueError("embedding_api must use a loopback host")

    @contextmanager
    def _open_client(self):
        """Serialize embedded-Qdrant access across Alpha-Memory processes."""
        with FileLock(self.lock_path, timeout=120.0, strict=True):
            client = QdrantClient(path=self.qdrant_path)
            self.client = client
            try:
                yield client
            finally:
                client.close()
                self.client = None

    def _ensure_collection(self, client):
        """确保 collection 存在；仅明确的不存在错误触发创建。"""
        try:
            info = client.get_collection(self.collection)
            if info.config.params.vectors.size != self.dimensions:
                raise ValueError("existing vector collection dimension mismatch")
            logger.debug(f"Collection '{self.collection}' exists")
            return
        except Exception as exc:
            name = type(exc).__name__.lower()
            message = str(exc).lower()
            missing = "notfound" in name or "not found" in message or "doesn't exist" in message
            if not missing:
                raise
        client.create_collection(
            collection_name=self.collection,
            vectors_config=models.VectorParams(
                size=self.dimensions,
                distance=models.Distance.COSINE
            )
        )
        logger.info(f"Created collection '{self.collection}'")
    
    def embed_texts(self, texts: List[str], timeout=120.0) -> List[List[float]]:
        """批量调用 Ollama embedding API（容错+重试）。"""
        if not texts:
            return []
        
        try:
            payload = json.dumps({"model": self.embedding_model, "input": texts}).encode('utf-8')
            req = urllib.request.Request(
                f"{self.embedding_api}/embeddings",
                data=payload,
                headers={'Content-Type': 'application/json'}
            )
            # No environment proxy or redirect may send local memory off-host.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    raise ValueError("embedding endpoint redirects are not permitted")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode('utf-8'))
            
            data = result["data"]
            if any("index" in item for item in data):
                if sorted(item.get("index", -1) for item in data) != list(range(len(texts))):
                    raise ValueError("embedding response indexes are missing or duplicated")
                data = sorted(data, key=lambda item: item["index"])
            embeddings = [item["embedding"] for item in data]
            if len(embeddings) != len(texts):
                raise ValueError(
                    f"embedding count mismatch: expected {len(texts)}, got {len(embeddings)}")
            for vector in embeddings:
                if len(vector) != self.dimensions:
                    raise ValueError(
                        f"embedding dimension mismatch: expected {self.dimensions}, got {len(vector)}")
            logger.debug(f"Embedded {len(texts)} texts -> {len(embeddings)} vectors")
            return embeddings
            
        except urllib.error.URLError as e:
            logger.error(f"Embedding API unreachable: {e}")
            raise ConnectionError(f"Cannot connect to {self.embedding_api}: {e}")
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON response from embedding API: {e}")
            raise
        except Exception as e:
            logger.error(f"Embedding failed: {e}")
            raise
    
    def index_node(self, node_id: str, content: str, acl_visible=True, sensitivity="private") -> bool:
        """索引单个节点（容错，失败返回 False）。"""
        try:
            if not content or not content.strip():
                logger.warning(f"Skipping empty content for node {node_id}")
                return False
            
            vector = self.embed_texts([content])[0]
            point_id = self._point_id(node_id)
            
            with self._open_client() as client:
                # Remove legacy randomized-hash IDs as well as the stable ID.
                self._delete_payload(client, [node_id])
                client.upsert(
                    collection_name=self.collection,
                    points=[models.PointStruct(
                        id=point_id,
                        vector=vector,
                        payload={
                            "node_id": node_id,
                            "acl_visible": acl_visible,
                            "sensitivity": sensitivity
                        }
                    )]
                )
            logger.debug(f"Indexed node {node_id} (point_id={point_id})")
            return True
            
        except Exception as e:
            logger.error(f"Failed to index node {node_id}: {e}")
            return False
    
    def index_nodes_batch(self, nodes: List[Tuple[str, str, bool, str]], batch_size=50) -> Tuple[int, int]:
        """批量索引节点（返回 成功数, 失败数）。
        
        Args:
            nodes: List of (node_id, content, acl_visible, sensitivity)
            batch_size: 批次大小
        
        Returns:
            (success_count, fail_count)
        """
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        if not nodes:
            return 0, 0
        
        success, fail = 0, 0
        
        for i in range(0, len(nodes), batch_size):
            batch = nodes[i:i+batch_size]
            valid = [item for item in batch if item[1] and item[1].strip()]
            invalid_count = len(batch) - len(valid)
            if not valid:
                fail += invalid_count
                continue

            # 批量 embed
            try:
                vectors = self.embed_texts([content for _, content, _, _ in valid])

                # 构造 points
                points = []
                for (node_id, _content, acl_visible, sensitivity), vector in zip(valid, vectors):
                    point_id = self._point_id(node_id)
                    points.append(models.PointStruct(
                        id=point_id,
                        vector=vector,
                        payload={
                            "node_id": node_id,
                            "acl_visible": acl_visible,
                            "sensitivity": sensitivity
                        }
                    ))

                # 批量 upsert
                with self._open_client() as client:
                    self._delete_payload(client, [item[0] for item in valid])
                    client.upsert(collection_name=self.collection, points=points)
                success += len(points)
                fail += invalid_count
                logger.info(f"Batch indexed {len(points)} nodes ({i+len(batch)}/{len(nodes)})")

            except Exception as e:
                logger.error(f"Batch indexing failed at offset {i}: {e}")
                fail += len(batch)
        
        return success, fail
    
    def search(self, query: str, limit=50, acl_visible=True,
               allowed_node_ids=None) -> List[Tuple[str, float]]:
        """Search, filtering authorized candidates before top-k truncation."""
        if allowed_node_ids is not None:
            allowed_node_ids = sorted(set(allowed_node_ids))
            if not allowed_node_ids:
                return []
        try:
            conditions = [models.FieldCondition(
                key="acl_visible", match=models.MatchValue(value=acl_visible))]
            if allowed_node_ids is not None:
                conditions.append(models.FieldCondition(
                    key="node_id", match=models.MatchAny(any=allowed_node_ids)))
            query_vector = self.embed_texts([query])[0]
            
            with self._open_client() as client:
                results = client.query_points(
                    collection_name=self.collection,
                    query=query_vector,
                    limit=limit,
                    query_filter=models.Filter(must=conditions),
                    with_payload=["node_id"]
                )
            
            hits = [(point.payload["node_id"], point.score) for point in results.points]
            logger.debug(f"Vector search '{query[:30]}...' returned {len(hits)} results")
            return hits
            
        except Exception as e:
            logger.error(f"Vector search failed: {e}")
            raise RuntimeError("vector search failed") from e
    
    def _delete_payload(self, client, node_ids):
        client.delete(
            collection_name=self.collection,
            points_selector=models.FilterSelector(filter=models.Filter(must=[
                models.FieldCondition(key="node_id", match=models.MatchAny(any=list(node_ids)))
            ])), wait=True)

    def delete_node(self, node_id: str) -> bool:
        """Delete every point for this node, including pre-repair legacy IDs."""
        try:
            with self._open_client() as client:
                self._delete_payload(client, [node_id])
            logger.debug(f"Deleted vector for node {node_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete node {node_id}: {e}")
            return False
    
    def close(self):
        """Clients are operation-scoped; kept for API compatibility."""
        self.client = None