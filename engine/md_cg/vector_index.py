# -*- coding: utf-8 -*-
"""Alpha Memory Qdrant vector integration module."""

from qdrant_client import QdrantClient, models
import urllib.request
import urllib.error
import json
import os
import logging
from typing import List, Tuple, Optional


logger = logging.getLogger(__name__)


class VectorIndex:
    """Qdrant 向量索引封装（支持批量操作、容错、日志）。"""
    
    def __init__(self, root_path, embedding_model="qwen3-embedding:0.6b", 
                 embedding_api="http://127.0.0.1:11434/v1",
                 auto_create_collection=True):
        self.root = root_path
        self.embedding_model = embedding_model
        self.embedding_api = embedding_api
        self.dimensions = 1024
        self.collection = "alpha_memory"
        
        qdrant_path = os.path.join(root_path, "qdrant")
        try:
            self.client = QdrantClient(path=qdrant_path)
            logger.info(f"VectorIndex initialized at {qdrant_path}")
        except Exception as e:
            logger.error(f"Failed to init Qdrant client: {e}")
            raise
        
        if auto_create_collection:
            self._ensure_collection()
    
    def _ensure_collection(self):
        """确保 collection 存在，不存在则创建。"""
        try:
            self.client.get_collection(self.collection)
            logger.debug(f"Collection '{self.collection}' exists")
        except Exception:
            try:
                self.client.create_collection(
                    collection_name=self.collection,
                    vectors_config=models.VectorParams(
                        size=self.dimensions,
                        distance=models.Distance.COSINE
                    )
                )
                logger.info(f"Created collection '{self.collection}'")
            except Exception as e:
                logger.error(f"Failed to create collection: {e}")
                raise
    
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
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode('utf-8'))
            
            embeddings = [item["embedding"] for item in result["data"]]
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
            point_id = abs(hash(node_id)) % (2**63)
            
            self.client.upsert(
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
        if not nodes:
            return 0, 0
        
        success, fail = 0, 0
        
        for i in range(0, len(nodes), batch_size):
            batch = nodes[i:i+batch_size]
            
            # 批量 embed
            try:
                contents = [content for _, content, _, _ in batch if content and content.strip()]
                if not contents:
                    fail += len(batch)
                    continue
                
                vectors = self.embed_texts(contents)
                
                # 构造 points
                points = []
                vec_idx = 0
                for node_id, content, acl_visible, sensitivity in batch:
                    if not content or not content.strip():
                        fail += 1
                        continue
                    
                    point_id = abs(hash(node_id)) % (2**63)
                    points.append(models.PointStruct(
                        id=point_id,
                        vector=vectors[vec_idx],
                        payload={
                            "node_id": node_id,
                            "acl_visible": acl_visible,
                            "sensitivity": sensitivity
                        }
                    ))
                    vec_idx += 1
                
                # 批量 upsert
                self.client.upsert(collection_name=self.collection, points=points)
                success += len(points)
                logger.info(f"Batch indexed {len(points)} nodes ({i+len(batch)}/{len(nodes)})")
                
            except Exception as e:
                logger.error(f"Batch indexing failed at offset {i}: {e}")
                fail += len(batch)
        
        return success, fail
    
    def search(self, query: str, limit=50, acl_visible=True) -> List[Tuple[str, float]]:
        """向量搜索（容错，返回 [(node_id, score), ...]）。"""
        try:
            query_vector = self.embed_texts([query])[0]
            
            results = self.client.query_points(
                collection_name=self.collection,
                query=query_vector,
                limit=limit,
                query_filter=models.Filter(must=[
                    models.FieldCondition(
                        key="acl_visible",
                        match=models.MatchValue(value=acl_visible)
                    )
                ]),
                with_payload=["node_id"]
            )
            
            hits = [(point.payload["node_id"], point.score) for point in results.points]
            logger.debug(f"Vector search '{query[:30]}...' returned {len(hits)} results")
            return hits
            
        except Exception as e:
            logger.error(f"Vector search failed: {e}")
            return []
    
    def delete_node(self, node_id: str) -> bool:
        """删除单个节点的向量。"""
        try:
            point_id = abs(hash(node_id)) % (2**63)
            self.client.delete(
                collection_name=self.collection,
                points_selector=models.PointIdsList(points=[point_id])
            )
            logger.debug(f"Deleted vector for node {node_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete node {node_id}: {e}")
            return False
    
    def close(self):
        """关闭客户端连接。"""
        try:
            if hasattr(self, 'client'):
                self.client.close()
                logger.info("VectorIndex client closed")
        except Exception as e:
            logger.warning(f"Error closing client: {e}")